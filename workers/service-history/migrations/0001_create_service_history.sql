-- One row per tube line per five-minute run. state is 'good', 'disrupted'
-- or 'closed' (TfL "Service Closed", i.e. outside operating hours).
CREATE TABLE IF NOT EXISTS status_samples (
    day TEXT NOT NULL,
    line_id TEXT NOT NULL,
    slot INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('good', 'disrupted', 'closed')),
    severity INTEGER NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (day, line_id, slot)
) WITHOUT ROWID;

-- Per-day totals, recomputed from status_samples after every run so the read
-- endpoint touches at most one row per line per day.
CREATE TABLE IF NOT EXISTS daily_line_service (
    day TEXT NOT NULL,
    line_id TEXT NOT NULL,
    good_samples INTEGER NOT NULL,
    disrupted_samples INTEGER NOT NULL,
    closed_samples INTEGER NOT NULL,
    last_slot INTEGER NOT NULL,
    PRIMARY KEY (day, line_id)
) WITHOUT ROWID;
