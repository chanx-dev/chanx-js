const MAX_NAME_LENGTH = 100;
const CHANNEL_NAME = /^[a-zA-Z\d\-_.]+(![\d\w\-_.]*)?$/;
const GROUP_NAME = /^[a-zA-Z\d\-_.]+$/;

const invalid = (kind: string) =>
  new TypeError(
    `${kind} name must be a valid unicode string with length < ${MAX_NAME_LENGTH} containing only ASCII alphanumerics, hyphens, underscores, or periods.`,
  );

/** Channels' naming rules, so a name valid here is valid for every Python layer. */
export function assertChannelName(name: string): void {
  if (name.length >= MAX_NAME_LENGTH || !CHANNEL_NAME.test(name))
    throw invalid('Channel');
}

export function assertGroupName(name: string): void {
  if (name.length >= MAX_NAME_LENGTH || !GROUP_NAME.test(name)) throw invalid('Group');
}
