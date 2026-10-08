package catalog

import "strings"

// staticFreeModels is the S3 bootstrap list: ids that completed a real
// anonymous chat request, each with the date it was verified. It only matters
// while the live catalog (S1) has never refreshed — afterwards S1 decides what
// exists and the metadata verdict decides what is free.
//
// Do not add an id here on the strength of its name alone; unverified ids
// belong in staticFreeCandidates.
var staticFreeModels = []string{
	"big-pickle",                      // verified 2026-08-28 (non-stream + stream)
	"mimo-v2.5-free",                  // verified 2026-08-28
	"ling-3.0-flash-fin-free",         // verified 2026-09-01
	"nemotron-3.5-lightning-free",     // verified 2026-09-01
	"nemotron-3-ultra-free",           // verified 2026-09-01
	"mimo-v2.6-flash-free",            // verified by opencode2dsh 0.3.7
	"muse-spark-1.2-contributor-free", // priced free upstream; region-blocked from our network
}

// staticFreeCandidates appeared in the live /v1/models listing on 2026-10-08
// but have not completed a verified anonymous chat from this service. Promote
// one into staticFreeModels only after a live request succeeds.
var staticFreeCandidates = []string{
	"jev-1.13-free",
	"exo-free",
	"space-bunny-free",
	"longcat-2.5-preview-free",
	"ling-3.1-flash-free",
	"fledge-alpha-free",
	"muse-spark-1.3-contributor-free",
}

func isStaticFreeModel(model string) bool {
	return containsString(staticFreeModels, model)
}

func staticFreeList() []string {
	out := make([]string, len(staticFreeModels))
	copy(out, staticFreeModels)
	return out
}

// isFreeModel is the name-based fallback, used only while metadata cannot
// speak (models.dev not ready, or the id missing from it).
func isFreeModel(model string) bool {
	return strings.Contains(strings.ToLower(model), "free")
}

func containsString(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}
