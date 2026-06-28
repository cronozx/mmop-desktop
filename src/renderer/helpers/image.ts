/**
 * Reads an image File, scales it down to fit within `maxSize`×`maxSize`, and
 * returns a compact WebP data URL. Used for Pro modpack icons so the stored
 * image stays small (the backend caps the data-URL size and validates format).
 */
export async function resizeImageToDataUrl(file: File, maxSize = 256): Promise<string> {
    const sourceUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('Could not read the image file.'));
        reader.readAsDataURL(file);
    });

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Could not decode the image.'));
        img.src = sourceUrl;
    });

    const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not process the image.');
    ctx.drawImage(image, 0, 0, width, height);

    return canvas.toDataURL('image/webp', 0.9);
}
