import { render } from '@testing-library/react';
import { useMeasure } from 'react-use';

import { VizLayout } from './VizLayout';

jest.mock('react-use', () => ({
  ...jest.requireActual('react-use'),
  useMeasure: jest.fn(),
}));

const useMeasureMock = jest.mocked(useMeasure);

describe('VizLayout', () => {
  beforeEach(() => {
    Object.defineProperty(document.body, 'clientWidth', { configurable: true, value: 1800 });
  });

  it('clamps a configured legend width to its CSS max width', () => {
    useMeasureMock.mockReturnValue([
      jest.fn(),
      {
        bottom: 400,
        height: 400,
        left: 448,
        right: 1120,
        top: 0,
        width: 672,
        x: 448,
        y: 0,
      },
    ]);
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
    useMeasureMock.mockReturnValue([
      jest.fn(),
      { bottom: 100, height: 100, left: 0, right: 900, top: 0, width: 900, x: 0, y: 0 },
    ]);
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

  it('uses the measured width for an automatically sized right legend', () => {
    useMeasureMock.mockReturnValue([
      jest.fn(),
      { bottom: 400, height: 400, left: 820, right: 1120, top: 0, width: 300, x: 820, y: 0 },
    ]);
    const renderViz = jest.fn(() => null);

    render(
      <VizLayout width={1120} height={400} legend={<VizLayout.Legend placement="right">Legend</VizLayout.Legend>}>
        {renderViz}
      </VizLayout>
    );

    expect(renderViz).toHaveBeenCalledWith(820, 400);
  });

  it('normalizes a negative configured width before applying layout styles', () => {
    useMeasureMock.mockReturnValue([
      jest.fn(),
      { bottom: 400, height: 400, left: 0, right: 1120, top: 0, width: 1120, x: 0, y: 0 },
    ]);
    const renderViz = jest.fn(() => null);

    const { container } = render(
      <VizLayout
        width={1120}
        height={400}
        legend={
          <VizLayout.Legend placement="right" width={-100}>
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
});
