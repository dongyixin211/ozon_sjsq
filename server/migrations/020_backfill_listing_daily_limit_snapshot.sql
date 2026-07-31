UPDATE gallery_listing_batch_assets
SET config_snapshot = jsonb_strip_nulls(
  COALESCE(config_snapshot, '{}'::jsonb)
  || jsonb_build_object(
    'externalShopId', COALESCE(config_snapshot->>'externalShopId', external_shop_id),
    'shopName', COALESCE(config_snapshot->>'shopName', shop_name),
    'localShopId', COALESCE(config_snapshot->>'localShopId', external_shop_id),
    'productTemplateId', COALESCE(config_snapshot->>'productTemplateId', product_template_id),
    'productTemplateName', COALESCE(config_snapshot->>'productTemplateName', product_template_name),
    'dailyListingLimit', CASE
      WHEN config_snapshot->>'dailyListingLimit' ~ '^[0-9]+$' THEN (config_snapshot->>'dailyListingLimit')::int
      ELSE 300
    END
  )
)
WHERE config_snapshot IS NULL
  OR config_snapshot->'dailyListingLimit' IS NULL;

UPDATE gallery_listing_batch_shops
SET config_snapshot = jsonb_strip_nulls(
  COALESCE(config_snapshot, '{}'::jsonb)
  || jsonb_build_object(
    'externalShopId', COALESCE(config_snapshot->>'externalShopId', external_shop_id),
    'shopName', COALESCE(config_snapshot->>'shopName', shop_name),
    'localShopId', COALESCE(config_snapshot->>'localShopId', external_shop_id),
    'productTemplateId', COALESCE(config_snapshot->>'productTemplateId', product_template_id),
    'productTemplateName', COALESCE(config_snapshot->>'productTemplateName', product_template_name),
    'dailyListingLimit', CASE
      WHEN config_snapshot->>'dailyListingLimit' ~ '^[0-9]+$' THEN (config_snapshot->>'dailyListingLimit')::int
      ELSE 300
    END
  )
)
WHERE config_snapshot IS NULL
  OR config_snapshot->'dailyListingLimit' IS NULL;
