// Built-in agent catalog. Pure declarative data (ADR 0009): no functions, no role logic.
// Role packages in separate repositories will publish the same shapes.
import type { CatalogDefinitions } from '../../contracts/src/catalog.js';
import { qaEngineer, qaEngineerV1_2 } from './blueprints/qa-engineer.js';
import { skills } from './skills.js';
import { tools } from './tools.js';
import { workflows } from './workflows.js';

export const builtInCatalog: CatalogDefinitions = {
  skills,
  tools,
  workflows,
  blueprints: [qaEngineer, qaEngineerV1_2],
};
