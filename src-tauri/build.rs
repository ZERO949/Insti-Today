// El manifiesto de siempre de Tauri (controles comunes v6) más el «segment heap»
// de Windows 10 2004+: devuelve al sistema la memoria que se libera tras revisar
// Moodle; con el montón clásico el proceso se quedaba con ella.
const MANIFIESTO: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <heapType xmlns="http://schemas.microsoft.com/SMI/2020/WindowsSettings">SegmentHeap</heapType>
    </windowsSettings>
  </application>
</assembly>"#;

fn main() {
    let windows = tauri_build::WindowsAttributes::new().app_manifest(MANIFIESTO);
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("no se pudo preparar la compilación");
}
