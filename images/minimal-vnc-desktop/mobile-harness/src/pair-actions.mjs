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
  for (const field of ['x', 'fromX', 'toX', 'offsetX', 'deltaX', 'sourceOffsetX', 'targetOffsetX']) {
    if (Number.isFinite(result[field])) result[field] = Math.round(result[field] * Number(scale.x ?? 1));
  }
  for (const field of ['y', 'fromY', 'toY', 'offsetY', 'deltaY', 'sourceOffsetY', 'targetOffsetY']) {
    if (Number.isFinite(result[field])) result[field] = Math.round(result[field] * Number(scale.y ?? 1));
  }
  return result;
}

// Native pickers are not the same control on both platforms: Android steps a
// NumberPicker one tap at a time, iOS sets a wheel to a value in one call. An action
// can therefore declare the platforms it belongs to, and is dropped elsewhere. Without
// this a case can only describe one platform's picker.
export function runsOnPlatform(action, platformName) {
  const platforms = action?.platforms;
  if (platforms === undefined) return true;
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error(`Action ${action.name ?? action.type} has an invalid platforms list`);
  }
  return platforms.includes(platformName);
}

export function actionsForTarget(actions, targetName, platformName, coordinateScale) {
  return actions.filter((action) => runsOnPlatform(action, platformName)).map((action) => {
    const { targetOverrides, platformOverrides, platformTargetOverrides, platforms, ...shared } = action;
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
