package obs

import "testing"

func TestEventIsRedundant(t *testing.T) {
	cases := []struct {
		message string
		event   string
		want    bool
	}{
		{"zen-free listening", "listening", true},
		{"model catalog refreshed", "catalog_refreshed", true},
		{"upstream rate limited the anonymous lane", "rate_limited", true},
		{"upstream stream went idle; cancelling", "stream_idle_timeout", false},
		{"models.dev metadata refresh failed", "metadata_refresh_failed", true},
		{"anything", "", true},
	}
	for _, tc := range cases {
		if got := eventIsRedundant(tc.message, tc.event); got != tc.want {
			t.Errorf("eventIsRedundant(%q, %q) = %v, want %v", tc.message, tc.event, got, tc.want)
		}
	}
}

func TestRingKeepsNewest(t *testing.T) {
	ring := NewRing(3)
	for _, text := range []string{"a", "b", "c", "d"} {
		ring.Add("ch", text)
	}
	items := ring.Snapshot()
	if len(items) != 3 || items[0].Text != "b" || items[2].Text != "d" {
		t.Fatalf("ring window is wrong: %+v", items)
	}
}
