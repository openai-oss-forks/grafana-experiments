import { render } from '@testing-library/react';
import { useMeasure } from 'react-use';

import { VizLayout } from './VizLayout';

jest.mock('react-use', () => ({
  ...jest.requireActual('react-use'),
  useMeasure: jest.fn(),
}));

const useMeasureMock = jest.mocked(useMeasure);
const containerWidth = 1120;
const containerHeight = 400;

function mockLegendMeasure(width: number, height: number, left = 0) {
  useMeasureMock.mockReturnValue([
    jest.fn(),
    { bottom: height, height, left, right: left + width, top: 0, width, x: left, y: 0 },
  ]);
}

function layout(
  renderViz: jest.Mock,
  { placement = 'right', width, maxWidth }: { placement?: 'bottom' | 'right'; width: number; maxWidth?: string }
) {
  return (
    <VizLayout
      width={containerWidth}
      height={containerHeight}
      legend={
        <VizLayout.Legend placement={placement} width={width} maxWidth={maxWidth}>
          Legend
        </VizLayout.Legend>
      }
    >
      {renderViz}
    </VizLayout>
  );
}

describe('VizLayout', () => {
  beforeEach(() => {
    Object.defineProperty(document.body, 'clientWidth', { configurable: true, value: 1800 });
  });

  it('clamps a configured legend width to its CSS max width', () => {
    mockLegendMeasure(672, 400, 448);
    const renderViz = jest.fn(() => null);

    const { container } = render(layout(renderViz, { width: 700 }));

    expect(renderViz).toHaveBeenCalledWith(448, 400);
    expect(container.firstElementChild?.lastElementChild).toHaveStyle({ width: '700px', maxWidth: '60%' });
  });

  it('ignores a stale bottom measurement when switching a configured legend to the right', () => {
    mockLegendMeasure(900, 100);
    const renderViz = jest.fn(() => null);

    const { rerender } = render(layout(renderViz, { placement: 'bottom', width: 300 }));
    renderViz.mockClear();

    rerender(layout(renderViz, { width: 300 }));

    expect(renderViz).toHaveBeenCalledWith(820, 400);
  });

  it('uses an explicit zero width instead of a stale measurement', () => {
    mockLegendMeasure(300, 400, 820);
    const renderViz = jest.fn(() => null);

    const { container } = render(layout(renderViz, { width: 0 }));

    expect(renderViz).toHaveBeenCalledWith(1120, 400);
    expect(container.firstElementChild?.lastElementChild).toHaveStyle({ width: '0px' });
  });

  it('preserves a zero-width plot when the configured legend fills the container', () => {
    mockLegendMeasure(1120, 400);
    const renderViz = jest.fn(() => null);

    const { container } = render(layout(renderViz, { width: 2000, maxWidth: '100%' }));

    expect(renderViz).toHaveBeenCalledWith(0, 400);
    expect(container.firstElementChild?.lastElementChild).toHaveStyle({ width: '2000px', maxWidth: '100%' });
  });

  it('uses the measured width for CSS max widths that require browser layout', () => {
    mockLegendMeasure(320, 400, 800);
    const renderViz = jest.fn(() => null);

    const { container } = render(layout(renderViz, { width: 700, maxWidth: '20rem' }));

    expect(renderViz).toHaveBeenCalledWith(800, 400);
    expect(container.firstElementChild?.lastElementChild).toHaveStyle({ width: '700px', maxWidth: '20rem' });
  });
});
