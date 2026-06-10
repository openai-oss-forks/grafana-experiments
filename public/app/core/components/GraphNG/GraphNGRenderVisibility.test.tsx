import { render, screen } from '@testing-library/react';
import { useEffect } from 'react';

import { GraphNGRendererGate, GraphNGRenderVisibilityProvider } from './GraphNGRenderVisibility';

describe('GraphNG render visibility', () => {
  it('unmounts only a compact renderer while suspended', () => {
    const onMount = jest.fn();
    const onUnmount = jest.fn();

    function Renderer() {
      useEffect(() => {
        onMount();
        return () => {
          onUnmount();
        };
      }, []);
      return <div>renderer</div>;
    }

    const { rerender } = render(
      <GraphNGRenderVisibilityProvider active={true}>
        <GraphNGRendererGate suspendWhenInactive={true}>
          <Renderer />
        </GraphNGRendererGate>
      </GraphNGRenderVisibilityProvider>
    );

    expect(screen.getByText('renderer')).toBeInTheDocument();

    rerender(
      <GraphNGRenderVisibilityProvider active={false}>
        <GraphNGRendererGate suspendWhenInactive={true}>
          <Renderer />
        </GraphNGRendererGate>
      </GraphNGRenderVisibilityProvider>
    );

    expect(screen.queryByText('renderer')).not.toBeInTheDocument();
    expect(onUnmount).toHaveBeenCalledTimes(1);

    rerender(
      <GraphNGRenderVisibilityProvider active={true}>
        <GraphNGRendererGate suspendWhenInactive={true}>
          <Renderer />
        </GraphNGRendererGate>
      </GraphNGRenderVisibilityProvider>
    );

    expect(screen.getByText('renderer')).toBeInTheDocument();
    expect(onMount).toHaveBeenCalledTimes(2);
  });

  it('does not suspend legacy GraphNG renderers', () => {
    render(
      <GraphNGRenderVisibilityProvider active={false}>
        <GraphNGRendererGate suspendWhenInactive={false}>
          <div>legacy renderer</div>
        </GraphNGRendererGate>
      </GraphNGRenderVisibilityProvider>
    );

    expect(screen.getByText('legacy renderer')).toBeInTheDocument();
  });
});
