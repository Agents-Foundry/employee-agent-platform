import { z } from 'zod';
import type { AgentBlueprint } from '@agents-foundry/contracts';
import { evaluatePolicy } from '../../../packages/policy-engine/src/index.js';

export const qaBlueprint: AgentBlueprint = {
  id: 'engineering.qa-engineer',
  version: '1.1.0',
  title: 'QA Engineer',
  department: 'Engineering',
  mission:
    'Plan quality checks, collect evidence, and request approval before browser execution or external writes.',
  skills: ['story-analysis', 'risk-based-test-planning', 'regression-analysis', 'defect-reporting'],
  questionnaire: [
    { id: 'projectName', label: 'Project name', type: 'text', required: true },
    { id: 'repositoryUrl', label: 'Repository URL', type: 'url', required: true },
    { id: 'qaUrl', label: 'QA environment URL', type: 'url', required: true },
    {
      id: 'issueTracker',
      label: 'Issue tracker',
      type: 'multiselect',
      required: true,
      options: ['Jira', 'Azure DevOps', 'Linear'],
    },
    {
      id: 'sourceControl',
      label: 'Source control',
      type: 'multiselect',
      required: true,
      options: ['Bitbucket', 'GitHub', 'GitLab'],
    },
    {
      id: 'testingTechnologies',
      label: 'Testing technologies',
      type: 'multiselect',
      required: true,
      options: ['Playwright', 'Cypress', 'Selenium', 'REST APIs'],
    },
  ],
  capabilities: [
    'repository.read',
    'jira.read',
    'qa.plan',
    'qa.execute_playwright',
    'jira.issue.create',
    'repository.pull_request.create',
    'production.deploy',
  ].map((action) => ({ action, outcome: evaluatePolicy(action).outcome })),
};

export function validateAnswers(answers: Record<string, unknown>) {
  const fields: Record<string, z.ZodType> = {};
  for (const question of qaBlueprint.questionnaire) {
    let field: z.ZodType;
    if (question.type === 'multiselect') {
      field = z
        .array(z.enum(question.options as [string, ...string[]]))
        .min(1)
        .max(question.options!.length)
        .refine((items) => new Set(items).size === items.length);
    } else if (question.type === 'url') {
      field = z
        .url()
        .max(2048)
        .refine((value) => {
          const url = new URL(value);
          return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
        }, 'Use an HTTP(S) URL without embedded credentials.');
    } else {
      field = z.string().trim().min(1).max(200);
    }
    fields[question.id] = question.required ? field : field.optional();
  }
  return z.object(fields).strict().parse(answers) as Record<string, string | string[]>;
}
