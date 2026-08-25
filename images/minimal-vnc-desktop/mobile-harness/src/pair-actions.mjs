export function actionsForTarget(actions, targetName) {
  return actions.map((action) => {
    const { targetOverrides, ...shared } = action;
    const overrides = targetOverrides?.[targetName];
    if (overrides === undefined) return shared;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      throw new Error(`Action ${action.name ?? action.type} has an invalid ${targetName} target override`);
    }
    if ('type' in overrides || 'name' in overrides) {
      throw new Error(`Action ${action.name ?? action.type} target override cannot change type or name`);
    }
    return { ...shared, ...overrides };
  });
}
