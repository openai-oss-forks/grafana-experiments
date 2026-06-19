import { render } from '@testing-library/react';
import { useMeasure } from 'react-use';

import { VizLayout } from './VizLayout';

jest.mock('react-use', () => ({
  ...jest.requireActual('react-use'),
  useMeasure: jest.fn(),
}));

const useMeasureMock = jest.mocked(useMeasure);

function mockLegendMeasure(width: number, height: number, left = 0) {
  useMeasureMock.mockReturnValue([
    jest.fn(),
    { bottom: height, height, left, right: left + width, top: 0, width, x: left, y: 0 },
  ]);
}

describe('VizLayout', () => {
  beforeEach(() => {
    Object.defineProperty(document.body, 'clientWidth', { configurable: true, value: 1800 });
  });

  it('clamps a configured legend width to its CSS max width', () => {
    mockLegendMeasure(672, 400, 448);
    const renderViz = jest.fn(() => null);

    const { container } = render(
      <VizLayout
        width={1120}
        height={400}
        legend={
          <VizLayout.Legend placement="right" width={700}>
            Legend
          </VizLayout.Legend>
        }
      >
        {renderViz}
      </VizLayout>
    );

    expect(renderViz).toHaveBeenCalledWith(448, 400);
    expect(container.firstElementChild?.lastElementChild).toHaveStyle({ width: '672px' });
  });

  it('ignores a stale bottom measurement when switching a configured legend to the right', () => {
    mockLegendMeasure(900, 100);
    const renderViz = jest.fn(() => null);

    const { rerender } = render(
      <VizLayout
        width={1120}
        height={400}
        legend={
          <VizLayout.Legend placement="bottom" width={300}>
            Legend
          </VizLayout.Legend>
        }
      >
        {renderViz}
      </VizLayout>
    );
    renderViz.mockClear();

    rerender(
      <VizLayout
        width={1120}
        height={400}
        legend={
          <VizLayout.Legend placement="right" width={300}>
            Legend
          </VizLayout.Legend>
        }
      >
        {renderViz}
      </VizLayout>
    );

    expect(renderViz).toHaveBeenCalledWith(820, 400);
  });

  it('uses an explicit zero width instead of a stale measurement', () => {
    mockLegendMeasure(300, 400, 820);
    const renderViz = jest.fn(() => null);

    const { container } = render(
      <VizLayout
        width={1120}
        height={400}
        legend={
          <VizLayout.Legend placement="right" width={0}>
            Legend
          </VizLayout.Legend>
        }
      >
        {renderViz}
      </VizLayout>
    );

    expect(renderViz).toHaveBeenCalledWith(1120, 400);
    expect(container.firstElementChild?.lastElementChild).toHaveStyle({ width: '0px' });
  });

  it('preserves a zero-width plot when the configured legend fills the container', () => {
    mockLegendMeasure(1120, 400);
    const renderViz = jest.fn(() => null);

    const { container } = render(
      <VizLayout
        width={1120}
        height={400}
        legend={
          <VizLayout.Legend placement="right" width={2000} maxWidth="100%">
            Legend
          </VizLayout.Legend>
        }
      >
        {renderViz}
      </VizLayout>
    );

    expect(renderViz).toHaveBeenCalledWith(0, 400);
    expect(container.firstElementChild?.lastElementChild).toHaveStyle({ width: '1120px' });
  });
});
