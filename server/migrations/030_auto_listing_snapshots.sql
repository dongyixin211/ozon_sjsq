ALTER TABLE gallery_auto_listing_runs
  ADD COLUMN IF NOT EXISTS plan_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE gallery_auto_listing_assignments
  ADD COLUMN IF NOT EXISTS plan_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS shop_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE gallery_auto_listing_runs run
SET plan_snapshot = jsonb_build_object(
  'id', plan.id,
  'name', plan.name,
  'productImageRuleId', plan.product_image_rule_id,
  'mockupTemplateId', plan.mockup_template_id,
  'mockupTemplateName', plan.mockup_template_name,
  'titlePromptTemplateId', plan.title_prompt_template_id,
  'titlePromptTemplateName', plan.title_prompt_template_name,
  'titlePrompt', plan.title_prompt,
  'shopConfigs', plan.shop_configs,
  'startMinute', plan.start_minute,
  'endMinute', plan.end_minute,
  'batchSize', plan.batch_size,
  'bufferSize', plan.buffer_size
)
FROM gallery_auto_listing_plans plan
WHERE plan.id = run.plan_id
  AND run.plan_snapshot = '{}'::jsonb;

UPDATE gallery_auto_listing_assignments assignment
SET plan_snapshot = run.plan_snapshot,
    shop_snapshot = COALESCE((
      SELECT shop_config
      FROM jsonb_array_elements(run.plan_snapshot->'shopConfigs') shop_config
      WHERE shop_config->>'externalShopId' = assignment.external_shop_id
      LIMIT 1
    ), '{}'::jsonb)
FROM gallery_auto_listing_runs run
WHERE run.id = assignment.run_id
  AND (assignment.plan_snapshot = '{}'::jsonb OR assignment.shop_snapshot = '{}'::jsonb);
