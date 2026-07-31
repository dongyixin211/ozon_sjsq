UPDATE gallery_auto_listing_runs run
SET status = 'completed',
    updated_at = now()
WHERE run.status = 'waiting'
  AND NOT EXISTS (
    SELECT 1
    FROM gallery_auto_listing_assignments assignment
    WHERE assignment.run_id = run.id
  );
