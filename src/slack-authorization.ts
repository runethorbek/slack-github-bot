// Port of slack_authorization.py.

export type PrivateDataRequest = {
  channelId: string;
  channelType: string;
  userId: string;
  authorizedUserId: string;
  authorizedChannelId: string;
};

/** Authorize private data through the existing channel or one user's DM. */
export function isPrivateDataRequestAuthorized({
  channelId,
  channelType,
  userId,
  authorizedUserId,
  authorizedChannelId,
}: PrivateDataRequest): boolean {
  // `bool(value)` on a str: an empty configured value never authorizes.
  const isAuthorizedChannel = Boolean(authorizedChannelId) && channelId === authorizedChannelId;
  const isAuthorizedDm =
    channelType === "im" && Boolean(authorizedUserId) && userId === authorizedUserId;
  return isAuthorizedChannel || isAuthorizedDm;
}
