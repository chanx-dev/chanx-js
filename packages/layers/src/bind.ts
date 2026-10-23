/**
 * Bind methods to their instance, so `const { send } = layer` works. Bound at
 * construction from the prototype chain, so a subclass's override is what gets bound.
 */
export function bindMethods<T extends object>(
  instance: T,
  names: readonly (keyof T)[],
): void {
  for (const name of names) {
    const method = instance[name];
    if (typeof method === 'function') instance[name] = method.bind(instance);
  }
}

export const LAYER_METHODS = [
  'newChannel',
  'send',
  'groupAdd',
  'groupDiscard',
  'groupSend',
  'flush',
] as const;
