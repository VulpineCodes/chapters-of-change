export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body style={{ fontFamily: 'system-ui, sans-serif', margin: 0 }}>
    <header style={{ padding: '1rem 2rem', borderBottom: '1px solid #e5e5e5', display: 'flex', gap: '1.5rem' }}>
      <strong>Chapters of Change</strong>
      <nav style={{ display: 'flex', gap: '1rem' }}><a href="/listings">Browse comics</a><a href="/dashboard/donor">Donor dashboard</a><a href="/dashboard/org">Organization dashboard</a></nav>
    </header><main style={{ padding: '2rem' }}>{children}</main></body></html>);
}
