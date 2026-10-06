import { ComponentProps, lazy, Suspense } from 'react';

const QueryEditor = lazy(() =>
  import('./PromQueryEditorByApp').then((module) => ({ default: module.PromQueryEditorByApp }))
);
const CheatSheet = lazy(() => import('./PromCheatSheet').then((module) => ({ default: module.PromCheatSheet })));
const AnnotationEditor = lazy(() =>
  import('./AnnotationQueryEditor').then((module) => ({ default: module.AnnotationQueryEditor }))
);
const VariableEditor = lazy(() =>
  import('./VariableQueryEditor').then((module) => ({ default: module.PromVariableQueryEditor }))
);

// Keep editor code out of datasource initialization. Each boundary is local so
// loading an editor does not suspend the dashboard or start its queries again.
export function PromQueryEditorByApp(props: ComponentProps<typeof QueryEditor>) {
  return (
    <Suspense fallback={null}>
      <QueryEditor {...props} />
    </Suspense>
  );
}

export function PromCheatSheet(props: ComponentProps<typeof CheatSheet>) {
  return (
    <Suspense fallback={null}>
      <CheatSheet {...props} />
    </Suspense>
  );
}

export function AnnotationQueryEditor(props: ComponentProps<typeof AnnotationEditor>) {
  return (
    <Suspense fallback={null}>
      <AnnotationEditor {...props} />
    </Suspense>
  );
}

export function PromVariableQueryEditor(props: ComponentProps<typeof VariableEditor>) {
  return (
    <Suspense fallback={null}>
      <VariableEditor {...props} />
    </Suspense>
  );
}
