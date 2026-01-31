package main

import (
	"context"
	"time"

	agonesv1 "agones.dev/agones/pkg/apis/agones/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"
)

// GameServerTTLReconciler reconciles a GameServer object
type GameServerTTLReconciler struct {
	client.Client
	Scheme      *runtime.Scheme
	TTLDuration time.Duration
}

const (
	// AnnotationLastAllocated is the annotation key used by Agones to store the allocation timestamp.
	// We use the one defined by Agones: agones.dev/last-allocated
	AnnotationLastAllocated = "agones.dev/last-allocated"
)

// Reconcile is part of the main kubernetes reconciliation loop which aims to
// move the current state of the cluster closer to the desired state.
func (r *GameServerTTLReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	// 1. Fetch the GameServer
	var gs agonesv1.GameServer
	if err := r.Get(ctx, req.NamespacedName, &gs); err != nil {
		if errors.IsNotFound(err) {
			// Object not found, return.  Created objects are automatically garbage collected.
			// For additional cleanup logic use finalizers.
			return ctrl.Result{}, nil
		}
		// Error reading the object - requeue the request.
		return ctrl.Result{}, err
	}

	// 2. Check if the GameServer is being deleted
	if !gs.ObjectMeta.DeletionTimestamp.IsZero() {
		return ctrl.Result{}, nil
	}

	// 3. Check State. We only care about Allocated GameServers.
	if gs.Status.State != agonesv1.GameServerStateAllocated {
		// Not allocated yet, or already shutdown/unhealthy. Nothing to do.
		// Note: If it transitions TO Allocated, we will get a Watch event.
		return ctrl.Result{}, nil
	}

	// 4. Get Allocation Timestamp
	lastAllocatedStr, ok := gs.Annotations[AnnotationLastAllocated]
	if !ok {
		// This is unexpected for an Allocated GameServer managed by Agones,
		// but maybe there's a race or it's a manual state change.
		// We can try to fall back to Status.LastAllocatedDate if available,
		// but the requirement specified the annotation.
		// Let's log and retry after a bit in case the annotation is being added asynchronously?
		// Or just ignore. Safer to ignore/log.
		log.Info("Allocated GameServer missing agones.dev/last-allocated annotation", "name", gs.Name)
		return ctrl.Result{}, nil
	}

	lastAllocated, err := time.Parse(time.RFC3339, lastAllocatedStr)
	if err != nil {
		log.Error(err, "Failed to parse last-allocated timestamp", "timestamp", lastAllocatedStr)
		// If we can't parse it, we can't enforce TTL.
		return ctrl.Result{}, nil
	}

	// 5. Calculate Expiry
	expiry := lastAllocated.Add(r.TTLDuration)
	now := time.Now()

	// 6. Check if expired
	if now.After(expiry) || now.Equal(expiry) {
		log.Info("GameServer TTL expired, deleting", "name", gs.Name, "age", now.Sub(lastAllocated))
		if err := r.Delete(ctx, &gs); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}

	// 7. Schedule Requeue
	timeLeft := expiry.Sub(now)
	log.Info("GameServer allocated but not yet expired", "name", gs.Name, "timeLeft", timeLeft)
	return ctrl.Result{RequeueAfter: timeLeft}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *GameServerTTLReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&agonesv1.GameServer{}).
		Complete(r)
}
