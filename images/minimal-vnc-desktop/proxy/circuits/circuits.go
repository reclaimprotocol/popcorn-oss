package circuits

import (
	_ "embed"
	"sync"

	"github.com/reclaimprotocol/reclaim-tee/client"
)

//go:embed pk.chacha20_oprf
var pkChacha20OPRF []byte

//go:embed r1cs.chacha20_oprf
var r1csChacha20OPRF []byte

//go:embed pk.aes128_oprf
var pkAES128OPRF []byte

//go:embed r1cs.aes128_oprf
var r1csAES128OPRF []byte

//go:embed pk.aes256_oprf
var pkAES256OPRF []byte

//go:embed r1cs.aes256_oprf
var r1csAES256OPRF []byte

var setupOnce sync.Once

func SetupZKCallback() {
	setupOnce.Do(func() {
		client.SetZKInitCallback(func(algorithmID uint8) <-chan bool {
			ch := make(chan bool, 1)
			go func() {
				var pk, r1cs []byte
				switch algorithmID {
				case client.CHACHA20_OPRF:
					pk, r1cs = pkChacha20OPRF, r1csChacha20OPRF
				case client.AES_128_OPRF:
					pk, r1cs = pkAES128OPRF, r1csAES128OPRF
				case client.AES_256_OPRF:
					pk, r1cs = pkAES256OPRF, r1csAES256OPRF
				default:
					ch <- false
					return
				}
				ch <- client.InitAlgorithmWithTracking(algorithmID, pk, r1cs)
			}()
			return ch
		})
	})
}
