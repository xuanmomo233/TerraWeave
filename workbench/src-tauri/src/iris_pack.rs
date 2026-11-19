use crate::iris_context::gl;
use serde::Deserialize;
use std::collections::HashMap;
use std::ffi::{CStr, CString};

#[derive(Deserialize)]
pub struct PackSources {
    pub name: String,
    pub hash: String,
    pub archive_sha256: Option<String>,
    pub programs: Vec<StageSource>,
    pub formats: Vec<String>,
    pub persistent: Vec<usize>,
    pub shadow_size: u32,
    pub noise_size: u32,
    pub shadow_translucent: bool,
    #[serde(default)]
    pub images: Vec<ImageSource>,
    #[serde(default)]
    pub textures: Vec<TextureSource>,
    #[serde(default)]
    pub storage: Vec<StorageSource>,
}

#[derive(Deserialize)]
pub struct ImageSource {
    pub image: String,
    pub sampler: String,
    pub format: String,
    pub clear: bool,
    pub relative: bool,
    pub size: [f32; 2],
}

#[derive(Deserialize)]
pub struct TextureSource {
    pub stage: Option<String>,
    pub sampler: String,
    pub png: String,
}

#[derive(Deserialize)]
pub struct StorageSource {
    pub binding: u32,
    pub bytes: usize,
    pub relative: Option<[f32;2]>,
    pub seed: Option<String>,
}

impl StorageSource {
    pub fn capacity(&self,width:i32,height:i32)->Option<usize>{
        let Some([x,y])=self.relative else{return Some(self.bytes)};
        let w=(x*width as f32) as usize;
        let h=(y*height as f32) as usize;
        self.bytes.checked_mul(w.max(1))?.checked_mul(h.max(1))
    }
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
    pub compute: Option<String>,
    pub group: Option<String>,
    pub groups: Option<[u32; 3]>,
    pub relative: Option<[f32; 2]>,
}

pub struct Program {
    handle: u32,
    pub source: StageSource,
    uniforms: HashMap<String, (i32, u32)>,
    pub samplers: Vec<(String, bool)>,
    pub images: Vec<String>,
    pub local_size: Option<[i32; 3]>,
    pub storage_blocks: Vec<(u32,usize)>,
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
    format!("#define MC_VERSION 12001\n#define MC_GL_VERSION {version}\n#define MC_GLSL_VERSION {version}\n#define {vendor_define} 1\n#define MC_OS_WINDOWS 1\n#define IS_IRIS 1\n#define MC_RENDER_QUALITY 1.0\n#define MC_RENDER_STAGE_NONE 0\n#define MC_RENDER_STAGE_SKY 1\n#define MC_RENDER_STAGE_CUSTOM_SKY 3\n#define MC_RENDER_STAGE_SUN 4\n#define MC_RENDER_STAGE_MOON 5\n#define MC_RENDER_STAGE_STARS 6\n#define MC_RENDER_STAGE_TERRAIN_SOLID 8\n#define MC_RENDER_STAGE_BLOCK_ENTITIES 12\n#define MC_RENDER_STAGE_TERRAIN_TRANSLUCENT 17\n")
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
            || source.mipmaps.iter().any(|n| *n > 15)
            || !source.alpha_test.is_finite()
        {
            return Err("光影附件定义无效".into());
        }
        unsafe {
            let shaders = if let Some(compute)=source.compute.as_deref() {
                if !gl::DispatchCompute::is_loaded() || !gl::BindImageTexture::is_loaded() || !gl::MemoryBarrier::is_loaded() {
                    return Err("显卡驱动缺少 OpenGL 计算着色器能力".into());
                }
                vec![compile(gl::COMPUTE_SHADER,compute,defines).map_err(|e|format!("{}：{e}",source.name))?]
            } else {
                let v = compile(gl::VERTEX_SHADER, &source.vertex, defines)
                    .map_err(|e| format!("{} 顶点阶段：{e}", source.name))?;
                let f = match compile(gl::FRAGMENT_SHADER, &source.fragment, defines) {
                    Ok(f) => f,
                    Err(e) => {
                        gl::DeleteShader(v);
                        return Err(format!("{} 片段阶段：{e}", source.name));
                    }
                };
                vec![v,f]
            };
            let handle = gl::CreateProgram();
            for &shader in &shaders { gl::AttachShader(handle,shader); }
            // Keep Iris attributes away from the fixed-function vertex,
            // lightmap, color and normal array slots.
            gl::BindAttribLocation(handle, 11, b"mc_Entity\0".as_ptr().cast());
            gl::BindAttribLocation(handle, 12, b"mc_midTexCoord\0".as_ptr().cast());
            gl::BindAttribLocation(handle, 13, b"at_tangent\0".as_ptr().cast());
            gl::LinkProgram(handle);
            for shader in shaders { gl::DeleteShader(shader); }
            let mut status = 0;
            gl::GetProgramiv(handle, gl::LINK_STATUS, &mut status);
            if status == 0 {
                let error = log(handle, true);
                gl::DeleteProgram(handle);
                return Err(format!("{} 链接：{error}", source.name));
            }
            let mut uniforms = HashMap::new();
            let mut samplers = Vec::new();
            let mut images = Vec::new();
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
                if kind==gl::IMAGE_2D { images.push(name.clone()); }
                uniforms.insert(name, (location, kind));
            }
            let attribute = |n: &[u8]| gl::GetAttribLocation(handle, n.as_ptr().cast());
            let local_size=source.compute.as_ref().map(|_|{
                let mut size=[0;3];
                gl::GetProgramiv(handle,gl::COMPUTE_WORK_GROUP_SIZE,size.as_mut_ptr());
                size
            });
            let mut storage_blocks=Vec::new();
            if gl::GetProgramInterfaceiv::is_loaded()&&gl::GetProgramResourceiv::is_loaded() {
                let mut count=0;
                gl::GetProgramInterfaceiv(handle,gl::SHADER_STORAGE_BLOCK,gl::ACTIVE_RESOURCES,&mut count);
                for i in 0..count {
                    let mut result=[0i32;2];
                    let props=[gl::BUFFER_BINDING,gl::BUFFER_DATA_SIZE];
                    gl::GetProgramResourceiv(handle,gl::SHADER_STORAGE_BLOCK,i as u32,2,
                        props.as_ptr(),2,std::ptr::null_mut(),result.as_mut_ptr());
                    storage_blocks.push((result[0] as u32,result[1] as usize));
                }
            }
            Ok(Self {
                handle,
                source,
                uniforms,
                samplers,
                images,
                local_size,
                storage_blocks,
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
    fn loc(&self, key: &str, kind: u32) -> i32 {
        self.uniforms.get(key).filter(|(_, actual)| *actual==kind).map_or(-1, |(location,_)| *location)
    }
    pub fn float(&self, key: &str, value: f32) {
        unsafe {
            gl::Uniform1f(self.loc(key, gl::FLOAT), value);
        }
    }
    pub fn int(&self, key: &str, value: i32) {
        if let Some(&(location, kind))=self.uniforms.get(key) {
            unsafe {
                match kind {
                    gl::FLOAT => gl::Uniform1f(location, value as f32),
                    gl::INT | gl::BOOL | gl::SAMPLER_2D | gl::SAMPLER_2D_SHADOW | gl::IMAGE_2D => gl::Uniform1i(location, value),
                    _ => {}
                }
            }
        }
    }
    pub fn ivec2(&self, key: &str, value: [i32; 2]) {
        unsafe {
            gl::Uniform2iv(self.loc(key, gl::INT_VEC2), 1, value.as_ptr());
        }
    }
    pub fn vec3(&self, key: &str, value: [f32; 3]) {
        unsafe {
            gl::Uniform3fv(self.loc(key, gl::FLOAT_VEC3), 1, value.as_ptr());
        }
    }
    pub fn vec4(&self, key: &str, value: [f32; 4]) {
        unsafe {
            gl::Uniform4fv(self.loc(key, gl::FLOAT_VEC4), 1, value.as_ptr());
        }
    }
    pub fn matrix(&self, key: &str, value: &[f32; 16]) {
        unsafe {
            gl::UniformMatrix4fv(self.loc(key, gl::FLOAT_MAT4), 1, gl::FALSE, value.as_ptr());
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
    pub archive_sha256: String,
    pub programs: HashMap<String, Program>,
    pub formats: Vec<u32>,
    pub persistent: Vec<usize>,
    pub shadow_size: i32,
    pub noise_size: i32,
    pub shadow_translucent: bool,
    pub images: Vec<ImageSource>,
    pub textures: Vec<TextureSource>,
    pub storage: Vec<StorageSource>,
}

pub fn image_format(name:&str)->Option<u32> {
    match name {
        "R8"=>Some(gl::R8),"RG8"=>Some(gl::RG8),"RGBA8"=>Some(gl::RGBA8),
        "R16"=>Some(gl::R16),"RG16"=>Some(gl::RG16),"RGBA16"=>Some(gl::RGBA16),
        "R16F"=>Some(gl::R16F),"RG16F"=>Some(gl::RG16F),"RGBA16F"=>Some(gl::RGBA16F),
        "R32F"=>Some(gl::R32F),"RG32F"=>Some(gl::RG32F),"RGBA32F"=>Some(gl::RGBA32F),
        _=>None
    }
}
impl Pack {
    pub fn compile(source: PackSources) -> Result<Self, String> {
        let mut defines = macros();
        if !source.images.is_empty() { defines.push_str("#define IRIS_FEATURE_CUSTOM_IMAGES\n"); }
        if source.programs.iter().any(|p|p.compute.is_some()) { defines.push_str("#define IRIS_FEATURE_COMPUTE_SHADERS\n"); }
        if !source.storage.is_empty() {
            if !gl::BindBufferBase::is_loaded()||!gl::ClearBufferData::is_loaded()
                ||!gl::MemoryBarrier::is_loaded()||!gl::GetProgramResourceiv::is_loaded() {
                return Err("显卡驱动缺少光影存储缓冲能力".into());
            }
            defines.push_str("#define IRIS_FEATURE_SSBO\n");
        }
        let mut programs = HashMap::new();
        if source.programs.len() > 256 || source.images.len()>16 || source.textures.len()>32
            || !(8..=16).contains(&source.formats.len())
            || !(256..=4096).contains(&source.shadow_size)
            || !(1..=512).contains(&source.noise_size)
            || source.persistent.iter().any(|n| *n >= source.formats.len())
        {
            return Err("不支持此光影包的缓冲区配置".into());
        }
        let mut image_names=std::collections::HashSet::new();
        let mut sampler_names=std::collections::HashSet::new();
        for image in &source.images {
            if !image_names.insert(&image.image)||!sampler_names.insert(&image.sampler)
                ||image_format(&image.format).is_none()||image.size.iter().any(|n|!n.is_finite()||*n<=0.0
                    ||if image.relative {*n>4.0} else {*n>4096.0||n.fract()!=0.0})
            { return Err(format!("自定义光影图像配置无效：{}",image.image)); }
        }
        let mut buffer_bindings=std::collections::HashSet::new();
        for buffer in &source.storage {
            if buffer.binding>8||!buffer_bindings.insert(buffer.binding)||buffer.bytes==0||buffer.bytes>128*1024*1024
                ||buffer.relative.is_some_and(|dims|dims.iter().any(|n|!n.is_finite()||*n<=0.0||*n>4.0))
                ||buffer.relative.is_some()&&buffer.seed.is_some()
            {return Err(format!("无效的光影存储缓冲 {}",buffer.binding));}
        }
        for stage in source.programs {
            if stage.mipmaps.iter().any(|slot| *slot>=source.formats.len()) {
                return Err(format!("{} 引用了未分配的 Mipmap 缓冲", stage.name));
            }
            let name = stage.name.clone();
            if programs.contains_key(&name) {
                return Err(format!("光影阶段重复：{name}"));
            }
            let program=Program::new(stage,&defines)?;
            if let Some((binding,_))=program.storage_blocks.iter().find(|(binding,minimum)|!source.storage.iter()
                .any(|b|b.binding==*binding&&(b.relative.is_some()||b.bytes>=*minimum))){
                return Err(format!("{name} 缺少足够的存储缓冲 {binding}"));
            }
            programs.insert(name,program);
        }
        for needed in [
            "shadow",
            "gbuffers_skybasic",
            "gbuffers_skytextured",
            "gbuffers_terrain",
            "gbuffers_water",
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
                "R8" => Ok(gl::R8),
                "RG8" => Ok(gl::RG8),
                "RGB8" => Ok(gl::RGB8),
                "R16" => Ok(gl::R16),
                "RG16" => Ok(gl::RG16),
                "RGB16" => Ok(gl::RGB16),
                "R16F" => Ok(gl::R16F),
                "RG16F" => Ok(gl::RG16F),
                "RGB16F" => Ok(gl::RGB16F),
                "R32F" => Ok(gl::R32F),
                "RG32F" => Ok(gl::RG32F),
                "RGB32F" => Ok(gl::RGB32F),
                "RGB10_A2" => Ok(gl::RGB10_A2),
                _ => Err(format!("不支持颜色缓冲格式 {name}")),
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            name: source.name,
            archive_sha256: source.archive_sha256.unwrap_or_else(||source.hash.clone()),
            hash: source.hash,
            programs,
            formats,
            persistent: source.persistent,
            shadow_size: source.shadow_size as i32,
            noise_size: source.noise_size as i32,
            shadow_translucent: source.shadow_translucent,
            images:source.images,
            textures:source.textures,
            storage:source.storage,
        })
    }
}
