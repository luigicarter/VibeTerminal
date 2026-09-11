'use strict';

// Application-owned delivery boundaries. A general terminal interaction cannot
// become a task handoff just because it happened to send one prompt.
function handoffTargets(grant) {
  if (grant?.kind !== 'operate_terminal' || grant.inspection) return [];
  if (grant.routing?.binding && grant.targets?.length === 1) return [{ ...grant.routing, target: grant.targets[0] }];
  if (grant.operationMode !== 'task' || !grant.taskBindings) return [];
  return (grant.targets || []).flatMap(target => {
    const binding = grant.taskBindings[target.id];
    return binding?.binding?.id === target.id && binding.binding.generation === target.generation ? [{ ...binding, target }] : [];
  });
}
module.exports = { handoffTargets };
