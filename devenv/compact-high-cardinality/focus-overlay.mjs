export async function seekCompactFocusOverlay(page, scope, bounds) {
  let overlayCount = await scope.locator('.u-compact-focus-overlay').count();
  if (overlayCount > 0) {
    return { overlayCount, responseMs: 0, searchMs: 0 };
  }

  const startedAt = performance.now();
  const cursorPoint = await scope
    .locator('.uplot')
    .first()
    .evaluate((plot, plotBounds) => {
      for (const point of plot.querySelectorAll('.u-cursor-pt')) {
        const pointBounds = point.getBoundingClientRect();
        const x = pointBounds.left + pointBounds.width / 2;
        const y = pointBounds.top + pointBounds.height / 2;
        if (
          pointBounds.width > 0 &&
          pointBounds.height > 0 &&
          x >= plotBounds.x &&
          x <= plotBounds.x + plotBounds.width &&
          y >= plotBounds.y &&
          y <= plotBounds.y + plotBounds.height
        ) {
          return { x, y };
        }
      }
      return null;
    }, bounds)
    .catch(() => null);
  if (cursorPoint && contains(bounds, cursorPoint.x, cursorPoint.y)) {
    const responseMs = await moveAndSettle(page, cursorPoint.x, cursorPoint.y);
    overlayCount = await scope.locator('.u-compact-focus-overlay').count();
    if (overlayCount > 0) {
      return { overlayCount, responseMs, searchMs: performance.now() - startedAt };
    }
  }

  const xFractions = [0.5, 0.25, 0.75, 0.1, 0.9];
  const yFractions = [0.95, 0.9, 0.85, 0.75, 0.5, 0.25, 0.05];
  for (const xFraction of xFractions) {
    for (const yFraction of yFractions) {
      const responseMs = await moveAndSettle(
        page,
        bounds.x + bounds.width * xFraction,
        bounds.y + bounds.height * yFraction
      );
      overlayCount = await scope.locator('.u-compact-focus-overlay').count();
      if (overlayCount > 0) {
        return { overlayCount, responseMs, searchMs: performance.now() - startedAt };
      }
    }
  }

  return { overlayCount, responseMs: null, searchMs: performance.now() - startedAt };
}

async function moveAndSettle(page, x, y) {
  const startedAt = performance.now();
  await page.mouse.move(x, y);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return performance.now() - startedAt;
}

function contains(bounds, x, y) {
  return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
}
