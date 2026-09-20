/**
 * piexifjs bringt keine Typdeklarationen mit. Deklariert wird nur der Teil,
 * den der Export tatsächlich benutzt: EXIF lesen, Tag-Konstanten, und das
 * APP1-Segment als Binärstring wieder ausgeben.
 */
declare module 'piexifjs' {
  interface ExifDict {
    '0th': Record<number, unknown>;
    Exif: Record<number, unknown>;
    GPS: Record<number, unknown>;
    Interop: Record<number, unknown>;
    '1st': Record<number, unknown>;
    thumbnail: string | null;
  }

  const piexif: {
    load(jpegBinaryString: string): ExifDict;
    /** Liefert das vollständige APP1-Segment als Binärstring. */
    dump(exif: ExifDict): string;
    insert(exifBinaryString: string, jpegBinaryString: string): string;
    ImageIFD: Record<string, number>;
    ExifIFD: Record<string, number>;
    GPSIFD: Record<string, number>;
  };

  export default piexif;
}
