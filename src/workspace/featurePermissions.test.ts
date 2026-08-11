import { describe, expect, it } from 'vitest';
import { canAccessPage, PAGE_FEATURE_MAP } from './featurePermissions';

describe('featurePermissions', () => {
  it('limits GPT image generation to beta and admin features', () => {
    expect(PAGE_FEATURE_MAP.materialAiImage).toBe('ai.image_generation');
    expect(canAccessPage(new Set(['ai.image_generation']), 'materialAiImage')).toBe(true);
    expect(canAccessPage(new Set(['gallery.upload']), 'materialAiImage')).toBe(false);
    expect(canAccessPage(new Set(['*']), 'materialAiImage')).toBe(true);
  });
});
