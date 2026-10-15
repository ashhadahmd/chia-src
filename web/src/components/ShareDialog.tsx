import { useEffect, useState } from 'react'
import { api, type Share } from '../lib/api'
import Dialog from './Dialog'
import PeopleList from './PeopleList'

/** Give one person access to this document alone, without adding them to a workspace. */
export default function ShareDialog({ docId, title, onClose }: { docId: string; title: string; onClose: () => void }) {
  const [shares, setShares] = useState<Share[] | null>(null)
  const reload = () => api.listShares(docId).then(setShares)
  useEffect(() => {
    api.listShares(docId).then(setShares, () => setShares([]))
  }, [docId])

  const people = shares?.filter((s) => s.principal_type === 'user').map((s) => ({ key: s.id, name: s.label, role: s.role })) ?? null
  return (
    <Dialog title={`Share “${title || 'Untitled'}”`} intro="People you add find this document in their own library. They get this document only, nothing else of yours." onClose={onClose}>
      <PeopleList
        people={people}
        roles={['editor', 'viewer']}
        canManage
        onInvite={async (who, role) => {
          await api.share(docId, who, role)
          await reload()
        }}
        onRole={async (p, role) => {
          const share = shares?.find((s) => s.id === p.key)
          if (share) await api.share(docId, share.label, role)
          await reload()
        }}
        onRemove={async (p) => {
          await api.unshare(docId, Number(p.key))
          await reload()
        }}
      />
    </Dialog>
  )
}
