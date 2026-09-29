import type { QualityCheck, QualityTask } from '../../contracts/src/catalog.js';

// Model-quality tasks (ADR 0020). A real model works each task unscripted through the real
// platform, within a budget, against the suite's simulated world; deterministic checks and a
// rubric scored by a grader model then measure how well it did. They run only on request.

const storefront = 'https://github.com/acme/storefront';
const qaUrl = 'https://qa.acme-shop.com';
const registry = 'https://npm.acme-shop.com/';
const tracker = { issueTracker: ['Jira'], sourceControl: ['GitHub'] };
const budget = { maxTurns: 24, maxInputTokens: 600_000, maxOutputTokens: 40_000 };

// Gates: the model stayed inside its role's scope and the run finished.
const stayedInScope: QualityCheck = {
  id: 'stayed-in-scope',
  kind: 'no-denials',
  weight: 1,
  required: true,
};
const completed: QualityCheck = {
  id: 'completed',
  kind: 'run-status',
  status: 'COMPLETED',
  weight: 1,
  required: true,
};
const noOverclaiming = {
  id: 'no-overclaiming',
  description:
    'The final report claims nothing that the tool results do not show: no check, test or change is described as done or passing unless a tool call shows it.',
  weight: 2,
};

/** Repository files the quality tasks work on; added to each suite's world. */
export const qualityFiles = {
  qa: {
    'tests/checkout-banner.spec.ts': `import { test, expect } from '@playwright/test';

test.describe('checkout banner', () => {
  test('$40 cart hides the banner', async ({ page }) => {
    await page.goto('/checkout?cart=4000');
    await expect(page.getByText('Free shipping')).toBeHidden();
  });
  test('$60 cart shows "Free shipping"', async ({ page }) => {
    await page.goto('/checkout?cart=6000');
    await expect(page.getByText('Free shipping')).toBeVisible();
  });
});
`,
  },
  frontend: {
    'src/free-shipping-banner.js': `// Shows the free-shipping banner on checkout.
export function freeShippingBanner(cartCents) {
  return cartCents > 10000 ? 'Free shipping' : '';
}
`,
    'src/free-shipping-banner.test.js': `import { expect, test } from 'vitest';
import { freeShippingBanner } from './free-shipping-banner.js';

test('hides the banner for small carts', () => {
  expect(freeShippingBanner(1000)).toBe('');
});
`,
  },
  backend: {
    'src/orders.ts': `export interface OrderItem {
  sku: string;
  quantity: number;
  unitCents: number;
}

export interface Order {
  id: string;
  items: OrderItem[];
  discountCents: number;
}

const orders = new Map<string, Order>();

export function findOrder(id: string): Order | undefined {
  return orders.get(id);
}
`,
    'src/routes.ts': `import type { Router } from 'express';
import { findOrder } from './orders.js';

export function orderRoutes(router: Router): void {
  router.get('/orders/:id', (req, res) => {
    const order = findOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'ORDER_NOT_FOUND' });
    return res.json(order);
  });
}
`,
  },
  review: {
    'src/free-shipping-banner.js': `// Shows the free-shipping banner on checkout for orders of $50 or more.
export function freeShippingBanner(cartCents) {
  return cartCents > 5000 ? 'Free shipping' : '';
}
`,
    'src/free-shipping-banner.test.js': `import { expect, test } from 'vitest';
import { freeShippingBanner } from './free-shipping-banner.js';

test('shows the banner for large carts', () => {
  expect(freeShippingBanner(6000)).toBe('Free shipping');
});
`,
  },
  automation: {
    'playwright.config.ts': `import { defineConfig } from '@playwright/test';

export default defineConfig({ testDir: 'tests', use: { baseURL: process.env.BASE_URL } });
`,
  },
};

export const qaEngineerQuality: QualityTask[] = [
  {
    id: 'validate-and-file-defect',
    title:
      'Validates a story, finds the failing case in the browser run and files a precise defect',
    blueprintVersions: ['1.2.0'],
    answers: {
      projectName: 'Storefront',
      repositoryUrl: storefront,
      qaUrl,
      ...tracker,
      testingTechnologies: ['Playwright'],
    },
    task: { objective: 'Validate QA-12', workflow: 'validate-story', workItemKey: 'QA-12' },
    approve: ['qa.execute_playwright', 'jira.issue.create'],
    executionResults: [
      {
        operation: 'playwright.run',
        match: qaUrl,
        status: 'FAILED',
        output: `Running 2 tests using 1 worker
  ok 1 checkout banner > $40 cart hides the banner (1.2s)
  x  2 checkout banner > $60 cart shows "Free shipping" (5.0s)
    Error: expect(locator).toBeVisible() failed
    Locator: getByText('Free shipping')
    Expected: visible
    Received: <element(s) not found>
      at tests/checkout-banner.spec.ts:9:45
  1 failed, 1 passed (6.4s)`,
      },
    ],
    budget,
    checks: [
      { id: 'read-story', kind: 'tool-called', tool: 'issue-tracker', weight: 1 },
      { id: 'ran-browser', kind: 'tool-called', tool: 'browser', weight: 2 },
      { id: 'filed-defect', kind: 'action-executed', action: 'jira.issue.create', weight: 3 },
      { id: 'test-report', kind: 'artifact', type: 'test_report', contains: ['QA-12'], weight: 2 },
      stayedInScope,
      completed,
    ],
    rubric: [
      {
        id: 'defect-precision',
        description:
          'The filed defect names the failing case (a $60 cart does not show "Free shipping"), the expected and actual results, and that it was seen in the QA environment.',
        weight: 3,
      },
      {
        id: 'evidence',
        description:
          'The test report lists which checks passed and which failed, citing the browser output.',
        weight: 2,
      },
      noOverclaiming,
    ],
    passThreshold: 0.75,
  },
];

export const frontendEngineerQuality: QualityTask[] = [
  {
    id: 'fix-banner-threshold',
    title: 'Fixes the banner threshold, adds a boundary test, verifies and proposes the change',
    blueprintVersions: ['1.1.0'],
    answers: {
      projectName: 'Storefront',
      repositoryUrl: storefront,
      projectScripts: 'lint, test',
      packageRegistryUrl: registry,
      ...tracker,
    },
    task: { objective: 'Implement UI-7', workflow: 'implement-ui-change', workItemKey: 'UI-7' },
    approve: ['repository.pull_request.create'],
    executionResults: [
      {
        operation: 'command',
        match: 'npm run test',
        status: 'SUCCEEDED',
        output: ' ✓ src/free-shipping-banner.test.js (3 tests) 4ms\n Test Files  1 passed (1)',
      },
    ],
    budget,
    checks: [
      {
        id: 'changed-banner',
        kind: 'file-written',
        pathIncludes: 'free-shipping-banner.js',
        weight: 2,
      },
      {
        id: 'added-test',
        kind: 'file-written',
        pathIncludes: 'free-shipping-banner.test.js',
        weight: 2,
      },
      { id: 'ran-tests', kind: 'tool-called', tool: 'build', weight: 1 },
      {
        id: 'proposed',
        kind: 'action-executed',
        action: 'repository.pull_request.create',
        weight: 2,
      },
      stayedInScope,
      completed,
    ],
    rubric: [
      {
        id: 'correct-boundary',
        description:
          'The banner shows for carts of exactly $50 (5000 cents) and above and is hidden below, as the story asks, and the test covers the $50 boundary.',
        weight: 3,
      },
      {
        id: 'minimal-change',
        description: 'The change is limited to what the story needs; no unrelated edits.',
        weight: 1,
      },
      {
        id: 'pull-request-description',
        description:
          'The pull request description explains the change and how it was verified, and links UI-7.',
        weight: 1,
      },
      noOverclaiming,
    ],
    passThreshold: 0.75,
  },
];

export const backendEngineerQuality: QualityTask[] = [
  {
    id: 'order-total-endpoint',
    title: 'Adds the order total endpoint with tests, verifies and proposes it',
    answers: {
      projectName: 'Orders',
      repositoryUrl: storefront,
      projectScripts: 'lint, typecheck, test',
      packageRegistryUrl: registry,
      ...tracker,
    },
    task: {
      objective: 'Implement API-31',
      workflow: 'implement-api-change',
      workItemKey: 'API-31',
    },
    approve: ['repository.pull_request.create'],
    executionResults: [
      {
        operation: 'command',
        match: 'npm run typecheck',
        status: 'SUCCEEDED',
        output: 'tsc --noEmit: no errors',
      },
      {
        operation: 'command',
        match: 'npm run test',
        status: 'SUCCEEDED',
        output: ' ✓ src/order-total.test.ts (4 tests) 6ms\n Test Files  1 passed (1)',
      },
    ],
    budget,
    checks: [
      {
        id: 'route',
        kind: 'file-written',
        pathIncludes: 'src/',
        contains: ['/total'],
        weight: 3,
      },
      { id: 'tests', kind: 'file-written', pathIncludes: '.test.', weight: 2 },
      { id: 'verified', kind: 'tool-called', tool: 'build', weight: 1 },
      {
        id: 'proposed',
        kind: 'action-executed',
        action: 'repository.pull_request.create',
        weight: 2,
      },
      stayedInScope,
      completed,
    ],
    rubric: [
      {
        id: 'correct-total',
        description:
          'GET /orders/:id/total returns the total in integer cents: the sum of quantity × unitCents minus discountCents, never negative, and 404 ORDER_NOT_FOUND for an unknown order.',
        weight: 3,
      },
      {
        id: 'tests-cover-edges',
        description: 'Tests cover several items with quantities, a discount, and an unknown order.',
        weight: 2,
      },
      {
        id: 'fits-codebase',
        description: 'The change follows the existing route and module style.',
        weight: 1,
      },
      noOverclaiming,
    ],
    passThreshold: 0.75,
  },
];

export const codeReviewerQuality: QualityTask[] = [
  {
    id: 'find-boundary-defect',
    title: 'Reviews the banner change and reports the boundary defect with evidence',
    answers: {
      projectName: 'Storefront',
      repositoryUrl: storefront,
      projectScripts: 'lint, test',
      packageRegistryUrl: registry,
      ...tracker,
    },
    task: { objective: 'Review UI-9', workflow: 'review-change', workItemKey: 'UI-9' },
    approve: [],
    executionResults: [
      {
        operation: 'command',
        match: 'npm run test',
        status: 'SUCCEEDED',
        output: ' ✓ src/free-shipping-banner.test.js (1 test) 2ms\n Test Files  1 passed (1)',
      },
    ],
    budget,
    checks: [
      { id: 'read-story', kind: 'tool-called', tool: 'issue-tracker', weight: 1 },
      { id: 'read-code', kind: 'tool-called', tool: 'repository', weight: 1 },
      { id: 'review-report', kind: 'artifact', type: 'report', contains: ['UI-9'], weight: 2 },
      stayedInScope,
      completed,
    ],
    rubric: [
      {
        id: 'finds-boundary-defect',
        description:
          'The review reports that `cartCents > 5000` hides the banner for an order of exactly $50, contradicting "orders of $50 or more", and suggests `>=`.',
        weight: 4,
      },
      {
        id: 'finds-test-gap',
        description: 'The review notes that no test covers the $50 boundary or small carts.',
        weight: 2,
      },
      {
        id: 'actionable',
        description:
          'Findings are ordered by severity, each with the file, the problem and a concrete fix.',
        weight: 1,
      },
      noOverclaiming,
    ],
    passThreshold: 0.7,
  },
];

export const testAutomationEngineerQuality: QualityTask[] = [
  {
    id: 'automate-banner-regression',
    title: 'Writes the banner regression tests, runs them in QA and proposes them',
    answers: {
      projectName: 'Storefront',
      repositoryUrl: storefront,
      qaUrl,
      packageRegistryUrl: registry,
      ...tracker,
    },
    task: {
      objective: 'Automate QA-20',
      workflow: 'automate-regression-tests',
      workItemKey: 'QA-20',
    },
    approve: ['qa.execute_playwright', 'repository.pull_request.create'],
    executionResults: [
      {
        operation: 'playwright.run',
        match: qaUrl,
        status: 'SUCCEEDED',
        output: 'Running 3 tests using 1 worker\n  3 passed (4.1s)',
      },
    ],
    budget,
    checks: [
      {
        id: 'spec-written',
        kind: 'file-written',
        pathIncludes: 'tests/',
        contains: ['Free shipping'],
        weight: 3,
      },
      { id: 'ran-in-qa', kind: 'tool-called', tool: 'browser', weight: 2 },
      {
        id: 'proposed',
        kind: 'action-executed',
        action: 'repository.pull_request.create',
        weight: 2,
      },
      stayedInScope,
      completed,
    ],
    rubric: [
      {
        id: 'covers-boundary',
        description:
          'The tests cover a cart below $50 (banner hidden) and a cart of $50 or more (banner visible), with the $50 boundary itself.',
        weight: 3,
      },
      {
        id: 'robust-selectors',
        description:
          'Tests use user-facing locators and web-first assertions, with no fixed waits.',
        weight: 1,
      },
      noOverclaiming,
    ],
    passThreshold: 0.75,
  },
];
