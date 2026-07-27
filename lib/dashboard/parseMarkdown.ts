// Parses docs/project/PROJECT_STATUS.md and DECISION_LOG.md into the exact
// shape the dashboard renders. Both files are authored by this project's own
// maintainers (never user-submitted), so rendering their prose sections to
// HTML via `marked` needs no additional sanitization pass.
//
// This is the ONLY place project data is derived -- the frontend never
// duplicates it; it just renders whatever this returns.

import { marked } from 'marked'

export interface RoadmapPhase {
  phase: number
  name: string
  weight: number
  completion: number
  status: string
}

export interface ProjectStatus {
  overallStatus: string
  currentPhase: string
  currentObjective: string
  lastUpdated: string
  overallCompletionPercent: number
  executiveSummaryHtml: string
  last5DaysHtml: string
  recentlyCompletedHtml: string
  inProgressHtml: string
  nextActionsHtml: string
  roadmap: RoadmapPhase[]
  blockersHtml: string
  dependenciesHtml: string
  risksHtml: string
  decisionsRequiredHtml: string
  technicalHealthHtml: string
  environmentStatusHtml: string
}

export interface DecisionEntry {
  id: string
  date: string
  status: string
  decision: string
  context: string
  rationale: string
  alternativesConsidered: string[]
  impact: string
  affectedAreas: string[]
  supersedes: string | null
  supersededBy: string | null
  evidence: string[]
}

function splitSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>()
  const parts = markdown.split(/\n## /)
  for (const part of parts.slice(1)) {
    const newlineIndex = part.indexOf('\n')
    const title = (newlineIndex === -1 ? part : part.slice(0, newlineIndex)).trim()
    const body = newlineIndex === -1 ? '' : part.slice(newlineIndex + 1).trim()
    sections.set(title, body)
  }
  return sections
}

function extractFencedJson(body: string): unknown {
  const match = body.match(/```json\s*([\s\S]*?)```/)
  if (!match) return null
  return JSON.parse(match[1])
}

function html(body: string | undefined): string {
  if (!body) return ''
  return marked.parse(body, { async: false }) as string
}

function plain(body: string | undefined): string {
  return (body ?? '').trim()
}

export function parseProjectStatus(markdown: string): ProjectStatus {
  const sections = splitSections(markdown)

  const roadmap = (extractFencedJson(sections.get('Roadmap') ?? '') as RoadmapPhase[] | null) ?? []
  const totalWeight = roadmap.reduce((sum, p) => sum + p.weight, 0)
  const weightedCompletion = roadmap.reduce((sum, p) => sum + p.weight * p.completion, 0)
  const overallCompletionPercent = totalWeight > 0 ? Math.round((weightedCompletion / totalWeight) * 100) : 0

  return {
    overallStatus: plain(sections.get('Overall Status')),
    currentPhase: plain(sections.get('Current Phase')),
    currentObjective: plain(sections.get('Current Objective')),
    lastUpdated: plain(sections.get('Last Updated')),
    overallCompletionPercent,
    executiveSummaryHtml: html(sections.get('Executive Summary')),
    last5DaysHtml: html(sections.get('Last 5 Working Days')),
    recentlyCompletedHtml: html(sections.get('Recently Completed')),
    inProgressHtml: html(sections.get('In Progress')),
    nextActionsHtml: html(sections.get('Next Actions')),
    roadmap,
    blockersHtml: html(sections.get('Blockers')),
    dependenciesHtml: html(sections.get('Dependencies')),
    risksHtml: html(sections.get('Risks')),
    decisionsRequiredHtml: html(sections.get('Decisions Required')),
    technicalHealthHtml: html(sections.get('Technical Health')),
    environmentStatusHtml: html(sections.get('Environment Status')),
  }
}

export function parseDecisionLog(markdown: string): DecisionEntry[] {
  const parts = markdown.split(/\n## DEC-/)
  const entries: DecisionEntry[] = []
  for (const part of parts.slice(1)) {
    const parsed = extractFencedJson(part) as DecisionEntry | null
    if (parsed) entries.push(parsed)
  }
  // Most recent (highest ID) first for the "recent decisions" view.
  return entries.sort((a, b) => (a.id < b.id ? 1 : -1))
}
