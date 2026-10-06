import { ComponentProps, lazy, Suspense } from 'react';

const Editor = lazy(() => import('./ConfigEditorPackage').then((module) => ({ default: module.ConfigEditor })));

export function ConfigEditor(props: ComponentProps<typeof Editor>) {
  return (
    <Suspense fallback={null}>
      <Editor {...props} />
    </Suspense>
  );
}
