import { describe, expect, it } from 'vitest';
import { moduleForPage, workspaceModules, type PageKey } from './navigation';

const expectedPages: PageKey[] = [
  'dashboard',
  'materialPortrait',
  'materialAiImage',
  'materialTitle',
  'materialRename',
  'imageUpload',
  'imagePending',
  'imageProcessing',
  'imageUploaded',
  'imageFeatured',
  'ozon',
  'autoListingPlans',
  'orders',
  'jobs',
  'license',
  'adminUsers',
  'adminFeatures',
  'adminLogs',
];

describe('workspaceModules', () => {
  it('groups every existing page into the required five modules', () => {
    expect(workspaceModules.map((module) => ({
      key: module.key,
      pages: module.pages.map((page) => page.key),
    }))).toEqual([
      { key: 'home', pages: ['dashboard'] },
      {
        key: 'assets',
        pages: [
          'materialPortrait',
          'materialAiImage',
          'materialTitle',
          'materialRename',
          'imageUpload',
          'imagePending',
          'imageProcessing',
          'imageUploaded',
          'imageFeatured',
        ],
      },
      { key: 'listing', pages: ['ozon', 'autoListingPlans'] },
      { key: 'orders', pages: ['orders'] },
      { key: 'tasks', pages: ['jobs', 'license', 'adminUsers', 'adminFeatures', 'adminLogs'] },
    ]);
  });

  it('covers every page exactly once', () => {
    const mappedPages = workspaceModules.flatMap((module) => module.pages.map((page) => page.key));

    expect(mappedPages).toHaveLength(expectedPages.length);
    expect(new Set(mappedPages).size).toBe(expectedPages.length);
    expect([...mappedPages].sort()).toEqual([...expectedPages].sort());
  });

  it('finds the owning module for every page', () => {
    for (const page of expectedPages) {
      const module = moduleForPage(page);
      expect(module.pages.some((item) => item.key === page)).toBe(true);
    }
  });
});
