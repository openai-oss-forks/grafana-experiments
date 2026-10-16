import { render, waitFor } from '@testing-library/react';

import * as editors from './LazyEditors';

const mockLoaded = jest.fn();
const mockRender = jest.fn(() => null);

jest.mock('./PromQueryEditorByApp', () => {
  mockLoaded('query');
  return { PromQueryEditorByApp: mockRender };
});
jest.mock('./PromCheatSheet', () => {
  mockLoaded('help');
  return { PromCheatSheet: mockRender };
});
jest.mock('./AnnotationQueryEditor', () => {
  mockLoaded('annotation');
  return { AnnotationQueryEditor: mockRender };
});
jest.mock('./VariableQueryEditor', () => {
  mockLoaded('variable');
  return { PromVariableQueryEditor: mockRender };
});

it('does not load editors when initializing annotation and variable support', async () => {
  await import('../annotations');
  await import('../variables');
  expect(mockLoaded).not.toHaveBeenCalled();
});

it.each([
  ['PromQueryEditorByApp', 'query'],
  ['PromCheatSheet', 'help'],
  ['AnnotationQueryEditor', 'annotation'],
  ['PromVariableQueryEditor', 'variable'],
] as const)('loads %s on first render and forwards its props', async (name, moduleName) => {
  // The implementation is mocked; only prop forwarding and the loading boundary
  // are under test. The existing editor suites exercise the actual controls.
  const props = { onChange: jest.fn() };
  const Editor = editors[name];
  // @ts-expect-error The mocked editor does not need the full datasource props.
  render(<Editor {...props} />);
  await waitFor(() => expect(mockLoaded).toHaveBeenCalledWith(moduleName));
  expect(mockRender).toHaveBeenLastCalledWith(props, expect.anything());
});
