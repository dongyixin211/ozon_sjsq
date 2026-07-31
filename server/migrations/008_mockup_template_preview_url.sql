ALTER TABLE mockup_templates
  ADD COLUMN IF NOT EXISTS preview_url TEXT;

UPDATE mockup_templates
SET preview_url = CASE
  WHEN id = 'fangjin' THEN '/mockup-template-assets/fangjin/layers/scene-01-layer-000.png'
  WHEN id = 'ganfamao' THEN '/mockup-template-assets/ganfamao/preview.jpg'
  WHEN id = 'zhuobu' THEN '/mockup-template-assets/zhuobu/preview.jpg'
  ELSE preview_url
END
WHERE preview_url IS NULL;
