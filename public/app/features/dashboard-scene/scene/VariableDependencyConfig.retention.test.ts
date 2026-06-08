import { SceneObjectBase, SceneObjectState, VariableDependencyConfig } from '@grafana/scenes';

interface TestState extends SceneObjectState {
  query: string;
  title: string;
  data?: object;
}

class TestSceneObject extends SceneObjectBase<TestState> {}

describe('VariableDependencyConfig state ownership', () => {
  test('tracks configured paths without retaining unrelated query data', () => {
    const data = { response: new ArrayBuffer(1024) };
    const scene = new TestSceneObject({ query: 'up{cluster="$cluster"}', title: '$title', data });
    const dependency = new VariableDependencyConfig(scene, { statePaths: ['query'] });

    expect([...dependency.getNames()]).toEqual(['cluster']);
    expect(retainedState(dependency)).not.toHaveProperty('data');

    scene.setState({ data: { response: new ArrayBuffer(2048) } });
    expect([...dependency.getNames()]).toEqual(['cluster']);
    expect(retainedState(dependency)).not.toHaveProperty('data');
  });

  test('invalidates retained state when tracked paths change', () => {
    const scene = new TestSceneObject({ query: 'up{cluster="$cluster"}', title: '$title' });
    const dependency = new VariableDependencyConfig(scene, { statePaths: ['query'] });

    expect([...dependency.getNames()]).toEqual(['cluster']);
    dependency.setPaths(['title']);
    expect([...dependency.getNames()]).toEqual(['title']);
  });
});

function retainedState(dependency: VariableDependencyConfig<TestState>): TestState | Partial<TestState> | undefined {
  return (dependency as unknown as { _state?: TestState | Partial<TestState> })._state;
}
