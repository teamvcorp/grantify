import { Sidebar } from '@/components/sidebar'

/**
 * Shell layout for the authenticated app surface. The sidebar is shared across
 * all routes in this group; each page renders into the scrollable main area.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl p-6 md:p-8">{children}</div>
      </main>
    </div>
  )
}
