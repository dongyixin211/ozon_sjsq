CREATE SEQUENCE IF NOT EXISTS gallery_sync_version_seq;

ALTER TABLE gallery_assets
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS sync_version BIGINT;

UPDATE gallery_assets
SET sync_version = nextval('gallery_sync_version_seq')
WHERE sync_version IS NULL;

ALTER TABLE gallery_assets
  ALTER COLUMN sync_version SET DEFAULT nextval('gallery_sync_version_seq'),
  ALTER COLUMN sync_version SET NOT NULL;

CREATE INDEX IF NOT EXISTS gallery_assets_user_sync_version_idx
  ON gallery_assets (uploaded_by_user_id, sync_version);

CREATE OR REPLACE FUNCTION bump_gallery_asset_sync_version()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  NEW.sync_version = nextval('gallery_sync_version_seq');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gallery_assets_sync_version_trigger ON gallery_assets;
CREATE TRIGGER gallery_assets_sync_version_trigger
BEFORE UPDATE ON gallery_assets
FOR EACH ROW EXECUTE FUNCTION bump_gallery_asset_sync_version();

CREATE OR REPLACE FUNCTION touch_gallery_asset_from_relation()
RETURNS TRIGGER AS $$
DECLARE
  target_asset_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'gallery_usage' THEN
      target_asset_id = OLD.asset_id;
    ELSE
      target_asset_id = OLD.source_asset_id;
    END IF;
  ELSE
    IF TG_TABLE_NAME = 'gallery_usage' THEN
      target_asset_id = NEW.asset_id;
    ELSE
      target_asset_id = NEW.source_asset_id;
    END IF;
  END IF;
  IF target_asset_id IS NOT NULL THEN
    UPDATE gallery_assets SET updated_at = now() WHERE id = target_asset_id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gallery_mockup_results_touch_asset ON gallery_mockup_results;
CREATE TRIGGER gallery_mockup_results_touch_asset
AFTER INSERT OR UPDATE OR DELETE ON gallery_mockup_results
FOR EACH ROW EXECUTE FUNCTION touch_gallery_asset_from_relation();

DROP TRIGGER IF EXISTS gallery_usage_touch_asset ON gallery_usage;
CREATE TRIGGER gallery_usage_touch_asset
AFTER INSERT OR UPDATE OR DELETE ON gallery_usage
FOR EACH ROW EXECUTE FUNCTION touch_gallery_asset_from_relation();

DROP TRIGGER IF EXISTS gallery_listing_batch_assets_touch_asset ON gallery_listing_batch_assets;
CREATE TRIGGER gallery_listing_batch_assets_touch_asset
AFTER INSERT OR UPDATE OR DELETE ON gallery_listing_batch_assets
FOR EACH ROW EXECUTE FUNCTION touch_gallery_asset_from_relation();

CREATE OR REPLACE FUNCTION touch_gallery_assets_from_batch()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  UPDATE gallery_assets a
  SET updated_at = now()
  FROM gallery_listing_batch_assets lba
  WHERE lba.batch_id = NEW.id
    AND a.id = lba.source_asset_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gallery_listing_batches_touch_assets ON gallery_listing_batches;
CREATE TRIGGER gallery_listing_batches_touch_assets
AFTER UPDATE ON gallery_listing_batches
FOR EACH ROW EXECUTE FUNCTION touch_gallery_assets_from_batch();

CREATE OR REPLACE FUNCTION touch_gallery_assets_from_batch_shop()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE gallery_assets a
    SET updated_at = now()
    FROM gallery_listing_batch_assets lba
    WHERE lba.batch_id = OLD.batch_id
      AND a.id = lba.source_asset_id;
    RETURN OLD;
  END IF;
  UPDATE gallery_assets a
  SET updated_at = now()
  FROM gallery_listing_batch_assets lba
  WHERE lba.batch_id = NEW.batch_id
    AND a.id = lba.source_asset_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gallery_listing_batch_shops_touch_assets ON gallery_listing_batch_shops;
CREATE TRIGGER gallery_listing_batch_shops_touch_assets
AFTER INSERT OR UPDATE OR DELETE ON gallery_listing_batch_shops
FOR EACH ROW EXECUTE FUNCTION touch_gallery_assets_from_batch_shop();
