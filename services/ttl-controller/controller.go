package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	agonesv1 "agones.dev/agones/pkg/apis/agones/v1"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
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
	AnnotationExpiresAt     = "popcorn.dev/expires-at"
)

var errMissingLastAllocated = fmt.Errorf("missing %s annotation", AnnotationLastAllocated)
var errInvalidExplicitExpiry = errors.New("invalid explicit session expiry")

func sessionExpiry(gs agonesv1.GameServer, fallbackTTL time.Duration) (time.Time, time.Time, error) {
	if expiresAtStr := gs.Annotations[AnnotationExpiresAt]; expiresAtStr != "" {
		expiresAt, err := time.Parse(time.RFC3339, expiresAtStr)
		if err != nil {
			return time.Time{}, time.Time{}, fmt.Errorf("%w: %v", errInvalidExplicitExpiry, err)
		}
		return expiresAt, expiresAt.Add(-fallbackTTL), nil
	}

	lastAllocatedStr, ok := gs.Annotations[AnnotationLastAllocated]
	if !ok {
		return time.Time{}, time.Time{}, errMissingLastAllocated
	}

	lastAllocated, err := time.Parse(time.RFC3339, lastAllocatedStr)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}

	return lastAllocated.Add(fallbackTTL), lastAllocated, nil
}

// Reconcile is part of the main kubernetes reconciliation loop which aims to
// move the current state of the cluster closer to the desired state.
func (r *GameServerTTLReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	// 1. Fetch the GameServer
	var gs agonesv1.GameServer
	if err := r.Get(ctx, req.NamespacedName, &gs); err != nil {
		if k8serrors.IsNotFound(err) {
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

	// 4. Calculate Expiry
	expiry, lastAllocated, err := sessionExpiry(gs, r.TTLDuration)
	if err != nil {
		if err == errMissingLastAllocated {
			log.Info("Allocated GameServer missing agones.dev/last-allocated annotation", "name", gs.Name)
		} else if errors.Is(err, errInvalidExplicitExpiry) {
			log.Error(err, "Failed to parse explicit session expiry", "timestamp", gs.Annotations[AnnotationExpiresAt])
		} else {
			log.Error(err, "Failed to parse GameServer expiry metadata")
		}
		return ctrl.Result{}, nil
	}
	now := time.Now()

	// 5. Check if expired
	if now.After(expiry) || now.Equal(expiry) {
		log.Info("GameServer TTL expired, deleting", "name", gs.Name, "age", now.Sub(lastAllocated))

		// Get session ID from annotation (set during allocation)
		sessionID := gs.Annotations["popcorn.dev/session-id"]

		// Report expiry event to analytics (non-blocking)
		reportExpiry(ctx, gs.Name, sessionID)

		if err := r.Delete(ctx, &gs); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}

	// 6. Schedule Requeue
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
