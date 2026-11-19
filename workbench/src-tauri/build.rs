fn main() {
    use gl_generator::{Api, Fallbacks, GlobalGenerator, Profile, Registry};
    let path = std::path::Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR"))
        .join("iris_gl_bindings.rs");
    let mut bindings = std::fs::File::create(path).expect("OpenGL bindings output");
    Registry::new(Api::Gl, (4, 1), Profile::Compatibility, Fallbacks::All, [])
        .write_bindings(GlobalGenerator, &mut bindings)
        .expect("Generate OpenGL compatibility bindings");
    tauri_build::build();
}
