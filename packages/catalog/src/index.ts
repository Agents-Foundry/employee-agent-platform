// Built-in agent catalog. Pure declarative data (ADR 0009): no functions, no role logic.
// Role packages in separate repositories will publish the same shapes.
import type { CatalogDefinitions } from '../../contracts/src/catalog.js';
import { backendEngineer } from './blueprints/backend-engineer.js';
import { codeReviewer } from './blueprints/code-reviewer.js';
import { frontendEngineer, frontendEngineerV1_1 } from './blueprints/frontend-engineer.js';
import { qaEngineer, qaEngineerV1_2 } from './blueprints/qa-engineer.js';
import { testAutomationEngineer } from './blueprints/test-automation-engineer.js';
import { evaluationSuites } from './evaluations.js';
import { skills } from './skills.js';
import { tools } from './tools.js';
import { workflows } from './workflows.js';

export const builtInCatalog: CatalogDefinitions = {
  skills,
  tools,
  workflows,
  blueprints: [
    qaEngineer,
    qaEngineerV1_2,
    frontendEngineer,
    frontendEngineerV1_1,
    backendEngineer,
    codeReviewer,
    testAutomationEngineer,
  ],
  evaluationSuites,
};
