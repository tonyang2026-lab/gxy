function cropBounds(region, screenSize, imageSize) {
  if (!region || !screenSize || !imageSize || ![region.x,region.y,region.width,region.height,screenSize.width,screenSize.height,imageSize.width,imageSize.height].every(Number.isFinite) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || screenSize.width <= 0 || screenSize.height <= 0 || imageSize.width <= 0 || imageSize.height <= 0 || region.x + region.width > screenSize.width + 1 || region.y + region.height > screenSize.height + 1) throw new Error('截图区域超出屏幕范围');
  const x = Math.max(0, Math.floor(region.x * imageSize.width / screenSize.width));
  const y = Math.max(0, Math.floor(region.y * imageSize.height / screenSize.height));
  const right = Math.min(imageSize.width, Math.ceil((region.x + region.width) * imageSize.width / screenSize.width));
  const bottom = Math.min(imageSize.height, Math.ceil((region.y + region.height) * imageSize.height / screenSize.height));
  if (right <= x || bottom <= y) throw new Error('截图区域为空');
  return { x, y, width: right - x, height: bottom - y };
}
module.exports = { cropBounds };
