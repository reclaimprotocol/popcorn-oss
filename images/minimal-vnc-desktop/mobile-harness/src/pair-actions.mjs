function actionOverrides(action, overrides, label, { allowType = false } = {}) {
  if (overrides === undefined) return {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error(`Action ${action.name ?? action.type} has invalid ${label} overrides`);
  }
  if ('name' in overrides || (!allowType && 'type' in overrides)) {
    throw new Error(`Action ${action.name ?? action.type} ${label} overrides cannot change ${allowType ? 'name' : 'type or name'}`);
  }
  return overrides;
}

function scaleCoordinates(values, scale) {
  if (!scale) return values;
  const result = { ...values };
  for (const field of ['x', 'fromX', 'toX', 'offsetX', 'deltaX']) {
    if (Number.isFinite(result[field])) result[field] = Math.round(result[field] * Number(scale.x ?? 1));
  }
  for (const field of ['y', 'fromY', 'toY', 'offsetY', 'deltaY']) {
    if (Number.isFinite(result[field])) result[field] = Math.round(result[field] * Number(scale.y ?? 1));
  }
  return result;
}

export function actionsForTarget(actions, targetName, platformName, coordinateScale) {
  return actions.map((action) => {
    const { targetOverrides, platformOverrides, platformTargetOverrides, ...shared } = action;
    const platform = actionOverrides(action, platformOverrides?.[platformName], `${platformName} platform`);
    const target = actionOverrides(action, targetOverrides?.[targetName], `${targetName} target`);
    const platformTarget = actionOverrides(
      action,
      platformTargetOverrides?.[platformName]?.[targetName],
      `${platformName} ${targetName} target`,
      { allowType: true },
    );
    return {
      ...scaleCoordinates(shared, coordinateScale),
      ...platform,
      ...scaleCoordinates(target, coordinateScale),
      ...platformTarget,
    };
  });
}
