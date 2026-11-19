use crate::iris_context::gl;
use serde::Deserialize;
use std::collections::HashMap;
use std::ffi::{CStr, CString};

#[derive(Deserialize)]
pub struct PackSources {
    pub name: String,
    pub hash: String,
    pub programs: Vec<StageSource>,
    pub formats: Vec<String>,
    pub persistent: Vec<usize>,
    pub shadow_size: u32,
    pub noise_size: u32,
    pub shadow_translucent: bool,
}

#[derive(Deserialize)]
pub struct StageSource {
    pub name: String,
    vertex: String,
    fragment: String,
    pub targets: Vec<Option<String>>,
    pub mipmaps: Vec<usize>,
    pub blend: bool,
    pub alpha_test: f32,
}

pub struct Program {
    handle: u32,
    pub source: StageSource,
    uniforms: HashMap<String, i32>,
    pub samplers: Vec<(String, bool)>,
    pub entity: i32,
    pub midpoint: i32,
    pub tangent: i32,
}

fn gl_text(which: u32) -> String {
    unsafe {
        let ptr = gl::GetString(which);
        if ptr.is_null() {
            String::new()
        } else {
            CStr::from_ptr(ptr.cast()).to_string_lossy().into_owned()
        }
    }
}

pub fn driver() -> String {
    gl_text(gl::RENDERER)
}

fn macros() -> String {
    let vendor = gl_text(gl::VENDOR).to_lowercase();
    let vendor_define = if vendor.contains("ati") || vendor.contains("amd") {
        "MC_GL_VENDOR_ATI"
    } else if vendor.contains("nvidia") {
        "MC_GL_VENDOR_NVIDIA"
    } else if vendor.contains("intel") {
        "MC_GL_VENDOR_INTEL"
    } else {
        "MC_GL_VENDOR_OTHER"
    };
    let mut major = 0;
    let mut minor = 0;
    unsafe {
        gl::GetIntegerv(gl::MAJOR_VERSION, &mut major);
        gl::GetIntegerv(gl::MINOR_VERSION, &mut minor);
    }
    let version = major * 100 + minor * 10;
    format!("#define MC_VERSION 12001\n#define MC_GL_VERSION {version}\n#define MC_GLSL_VERSION {version}\n#define {vendor_define} 1\n#define MC_OS_WINDOWS 1\n#define IS_IRIS 1\n#define MC_RENDER_QUALITY 1.0\n")
}

fn stage_source(text: &str, defines: &str) -> Result<CString, String> {
    let (first, rest) = text.split_once('\n').ok_or("光影程序缺少版本行")?;
    if !first
        .trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with("#version")
    {
        return Err("光影程序必须以 #version 开头".into());
    }
    // Iris supplies platform macros at load time. Leave the pack's shader
    // code and default options intact after the original version directive.
    CString::new(format!(
        "{}\n{}#line 2\n{}",
        first.trim_start_matches('\u{feff}'),
        defines,
        rest
    ))
    .map_err(|_| "光影程序含无效字符".into())
}

unsafe fn log(handle: u32, program: bool) -> String {
    let mut length = 0;
    if program {
        gl::GetProgramiv(handle, gl::INFO_LOG_LENGTH, &mut length);
    } else {
        gl::GetShaderiv(handle, gl::INFO_LOG_LENGTH, &mut length);
    }
    let mut bytes = vec![0u8; length.clamp(1, 8192) as usize];
    if program {
        gl::GetProgramInfoLog(
            handle,
            bytes.len() as i32,
            std::ptr::null_mut(),
            bytes.as_mut_ptr().cast(),
        );
    } else {
        gl::GetShaderInfoLog(
            handle,
            bytes.len() as i32,
            std::ptr::null_mut(),
            bytes.as_mut_ptr().cast(),
        );
    }
    String::from_utf8_lossy(&bytes)
        .trim_end_matches('\0')
        .trim()
        .to_string()
}

unsafe fn compile(kind: u32, text: &str, defines: &str) -> Result<u32, String> {
    let text = stage_source(text, defines)?;
    let shader = gl::CreateShader(kind);
    gl::ShaderSource(shader, 1, &text.as_ptr(), std::ptr::null());
    gl::CompileShader(shader);
    let mut status = 0;
    gl::GetShaderiv(shader, gl::COMPILE_STATUS, &mut status);
    if status == 0 {
        let error = log(shader, false);
        gl::DeleteShader(shader);
        return Err(error);
    }
    Ok(shader)
}

impl Program {
    pub fn new(source: StageSource, defines: &str) -> Result<Self, String> {
        if source.targets.len() > 8
            || source.mipmaps.iter().any(|n| *n > 7)
            || !source.alpha_test.is_finite()
        {
            return Err("光影附件定义无效".into());
        }
        unsafe {
            let v = compile(gl::VERTEX_SHADER, &source.vertex, defines)
                .map_err(|e| format!("{} 顶点阶段：{e}", source.name))?;
            let f = match compile(gl::FRAGMENT_SHADER, &source.fragment, defines) {
                Ok(f) => f,
                Err(e) => {
                    gl::DeleteShader(v);
                    return Err(format!("{} 片段阶段：{e}", source.name));
                }
            };
            let handle = gl::CreateProgram();
            gl::AttachShader(handle, v);
            gl::AttachShader(handle, f);
            // Keep Iris attributes away from the fixed-function vertex,
            // lightmap, color and normal array slots.
            gl::BindAttribLocation(handle, 11, b"mc_Entity\0".as_ptr().cast());
            gl::BindAttribLocation(handle, 12, b"mc_midTexCoord\0".as_ptr().cast());
            gl::BindAttribLocation(handle, 13, b"at_tangent\0".as_ptr().cast());
            gl::LinkProgram(handle);
            gl::DeleteShader(v);
            gl::DeleteShader(f);
            let mut status = 0;
            gl::GetProgramiv(handle, gl::LINK_STATUS, &mut status);
            if status == 0 {
                let error = log(handle, true);
                gl::DeleteProgram(handle);
                return Err(format!("{} 链接：{error}", source.name));
            }
            let mut uniforms = HashMap::new();
            let mut samplers = Vec::new();
            let mut count = 0;
            gl::GetProgramiv(handle, gl::ACTIVE_UNIFORMS, &mut count);
            for index in 0..count {
                let mut name = [0i8; 256];
                let mut size = 0;
                let mut kind = 0;
                gl::GetActiveUniform(
                    handle,
                    index as u32,
                    name.len() as i32,
                    std::ptr::null_mut(),
                    &mut size,
                    &mut kind,
                    name.as_mut_ptr(),
                );
                let location = gl::GetUniformLocation(handle, name.as_ptr());
                if location < 0 {
                    continue;
                } // fixed-function uniforms are driver-managed
                let name = CStr::from_ptr(name.as_ptr()).to_string_lossy().into_owned();
                if kind == gl::SAMPLER_2D || kind == gl::SAMPLER_2D_SHADOW {
                    samplers.push((name.clone(), kind == gl::SAMPLER_2D_SHADOW));
                }
                uniforms.insert(name, location);
            }
            let attribute = |n: &[u8]| gl::GetAttribLocation(handle, n.as_ptr().cast());
            Ok(Self {
                handle,
                source,
                uniforms,
                samplers,
                entity: attribute(b"mc_Entity\0"),
                midpoint: attribute(b"mc_midTexCoord\0"),
                tangent: attribute(b"at_tangent\0"),
            })
        }
    }
    pub fn bind(&self) {
        unsafe {
            gl::UseProgram(self.handle);
        }
    }
    fn loc(&self, key: &str) -> i32 {
        self.uniforms.get(key).copied().unwrap_or(-1)
    }
    pub fn float(&self, key: &str, value: f32) {
        unsafe {
            gl::Uniform1f(self.loc(key), value);
        }
    }
    pub fn int(&self, key: &str, value: i32) {
        unsafe {
            gl::Uniform1i(self.loc(key), value);
        }
    }
    pub fn ivec2(&self, key: &str, value: [i32; 2]) {
        unsafe {
            gl::Uniform2iv(self.loc(key), 1, value.as_ptr());
        }
    }
    pub fn vec3(&self, key: &str, value: [f32; 3]) {
        unsafe {
            gl::Uniform3fv(self.loc(key), 1, value.as_ptr());
        }
    }
    pub fn vec4(&self, key: &str, value: [f32; 4]) {
        unsafe {
            gl::Uniform4fv(self.loc(key), 1, value.as_ptr());
        }
    }
    pub fn matrix(&self, key: &str, value: &[f32; 16]) {
        unsafe {
            gl::UniformMatrix4fv(self.loc(key), 1, gl::FALSE, value.as_ptr());
        }
    }
}
impl Drop for Program {
    fn drop(&mut self) {
        unsafe {
            gl::DeleteProgram(self.handle);
        }
    }
}

pub struct Pack {
    pub name: String,
    pub hash: String,
    pub programs: HashMap<String, Program>,
    pub formats: Vec<u32>,
    pub persistent: Vec<usize>,
    pub shadow_size: i32,
    pub noise_size: i32,
    pub shadow_translucent: bool,
}
impl Pack {
    pub fn compile(source: PackSources) -> Result<Self, String> {
        let defines = macros();
        let mut programs = HashMap::new();
        if source.programs.len() > 64
            || source.formats.len() != 8
            || !(256..=4096).contains(&source.shadow_size)
            || !(1..=512).contains(&source.noise_size)
            || source.persistent.iter().any(|n| *n > 7)
        {
            return Err("不支持此光影包的缓冲区配置".into());
        }
        for stage in source.programs {
            let name = stage.name.clone();
            if programs.contains_key(&name) {
                return Err(format!("光影阶段重复：{name}"));
            }
            programs.insert(name, Program::new(stage, &defines)?);
        }
        for needed in [
            "shadow",
            "gbuffers_skybasic",
            "gbuffers_skytextured",
            "gbuffers_terrain",
            "gbuffers_water",
            "composite",
            "final",
        ] {
            if !programs.contains_key(needed) {
                return Err(format!("光影包缺少目前所需的阶段 {needed}"));
            }
        }
        let formats = source
            .formats
            .iter()
            .map(|name| match name.as_str() {
                "RGBA" | "RGBA8" => Ok(gl::RGBA8),
                "RGBA16" => Ok(gl::RGBA16),
                "RGBA16F" => Ok(gl::RGBA16F),
                "RGBA32F" => Ok(gl::RGBA32F),
                "R11F_G11F_B10F" => Ok(gl::R11F_G11F_B10F),
                _ => Err(format!("不支持颜色缓冲格式 {name}")),
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            name: source.name,
            hash: source.hash,
            programs,
            formats,
            persistent: source.persistent,
            shadow_size: source.shadow_size as i32,
            noise_size: source.noise_size as i32,
            shadow_translucent: source.shadow_translucent,
        })
    }
}
