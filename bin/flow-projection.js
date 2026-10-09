'use strict';
/**
 * flow-projection.js · the state of an item computed from its events (ADR 0002). Pure: no I/O, no clock,
 * nothing is stored. The API and the screens consume only this projection.
 *
 *   projectItem(events, project) → ItemState | null
 *     events   the item's events, oldest first: { id, at, type, task_number, agent: {role, name}, source, payload }
 *     project  { id, tracker: 'github' | 'azure_devops', stages: ['specification', ...] } (the stages it uses)
 *     null when there is no item-started event (the item does not exist yet).
 *
 *   ItemState = {
 *     number, title, stage,                     current stage (a Stage id)
 *     stages: [{ id, status: 'done' | 'current' | 'pending', entered_at }],   the project's flow, in order
 *     started_at, updated_at, stage_since       moments taken from the events
 *   }
 *
 *   trackerRef(tracker, number) → "#12" (GitHub) | "PBI 3100" (Azure DevOps): the number as the tracker shows it.
 *
 * Event types read in this slice (others are ignored, so newer events never break an older panel):
 *   item-started   payload { title, stage }  (stage: where the item enters; earlier stages count as done)
 *   stage-changed  payload { stage }
 */

const EVENT_TYPES = { itemStarted: 'item-started', stageChanged: 'stage-changed' };

function trackerRef(tracker, number) {
  return tracker === 'azure_devops' ? `PBI ${number}` : `#${number}`;
}

function projectItem(events, project) {
  const list = Array.isArray(events) ? events : [];
  const start = list.find((e) => e && e.type === EVENT_TYPES.itemStarted);
  if (!start) return null;
  const flow = Array.isArray(project && project.stages) ? project.stages.slice() : [];
  const entered = new Map();
  let title = null;
  let stage = null;
  let stageSince = null;
  let updatedAt = start.at;
  for (const e of list.slice(list.indexOf(start))) {
    if (!e) continue;
    const p = (e.payload && typeof e.payload === 'object') ? e.payload : {};
    if (e === start) {
      title = typeof p.title === 'string' ? p.title : null;
      stage = typeof p.stage === 'string' ? p.stage : flow[0] || null;
    } else if (e.type === EVENT_TYPES.stageChanged && typeof p.stage === 'string') {
      if (p.stage === stage) { updatedAt = e.at; continue; }
      stage = p.stage;
    } else {
      continue;
    }
    entered.set(stage, e.at);
    stageSince = e.at;
    updatedAt = e.at;
  }
  // A stage the project no longer declares still shows, at the end, so the item never loses its place.
  if (stage && !flow.includes(stage)) flow.push(stage);
  const current = flow.indexOf(stage);
  return {
    number: start.item_number,
    title,
    stage,
    stages: flow.map((id, i) => ({
      id,
      status: i < current ? 'done' : i === current ? 'current' : 'pending',
      entered_at: i <= current ? entered.get(id) || null : null,
    })),
    started_at: start.at,
    updated_at: updatedAt,
    stage_since: stageSince,
  };
}

module.exports = { projectItem, trackerRef, EVENT_TYPES };
