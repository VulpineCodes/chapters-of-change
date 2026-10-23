export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (<div style={{ textAlign: 'center', padding: '3rem 1rem' }}><h2>{title}</h2>{hint && <p>{hint}</p>}</div>);
}
export function ErrorState({ message }: { message: string }) {
  return (<div role="alert" style={{ padding: '2rem' }}><h2>Could not load this page</h2><p>{message}</p></div>);
}
export function SuccessState({ message }: { message: string }) {
  return (<div role="status" style={{ padding: '1rem', border: '1px solid green' }}>{message}</div>);
}
