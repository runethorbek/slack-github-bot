def is_private_data_request_authorized(
    *,
    channel_id,
    channel_type,
    user_id,
    authorized_user_id,
    authorized_channel_id,
):
    """Authorize private data through the existing channel or one user's DM."""
    is_authorized_channel = (
        bool(authorized_channel_id) and channel_id == authorized_channel_id
    )
    is_authorized_dm = (
        channel_type == "im"
        and bool(authorized_user_id)
        and user_id == authorized_user_id
    )
    return is_authorized_channel or is_authorized_dm
