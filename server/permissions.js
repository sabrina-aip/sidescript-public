/** 'owner' | 'editor' | 'viewer' | null */
export function roleFor(meta, username) {
  if (!meta || !username) return null
  if (meta.owner === username) return 'owner'
  const r = meta.shares?.[username]
  return r === 'editor' || r === 'viewer' ? r : null
}

export const canEdit = (role) => role === 'owner' || role === 'editor'
