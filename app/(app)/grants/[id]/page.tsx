import { GrantWorkspace } from '@/components/grants/grant-workspace'

export default async function GrantWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return <GrantWorkspace grantId={id} />
}
