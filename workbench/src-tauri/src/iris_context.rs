//! A workbench-owned, hidden Windows OpenGL compatibility context.
//! No game process, graphics remoting or Minecraft installation is involved.
use std::ffi::{c_char, c_void, CString};
use std::ptr::null_mut;

#[allow(clippy::all, unsafe_op_in_unsafe_fn)]
pub mod gl {
    include!(concat!(env!("OUT_DIR"), "/iris_gl_bindings.rs"));
}

type Handle = *mut c_void;

#[repr(C)]
struct PixelFormat {
    size: u16,
    version: u16,
    flags: u32,
    pixel_type: u8,
    color_bits: u8,
    red_bits: u8,
    red_shift: u8,
    green_bits: u8,
    green_shift: u8,
    blue_bits: u8,
    blue_shift: u8,
    alpha_bits: u8,
    alpha_shift: u8,
    accum_bits: u8,
    accum_red_bits: u8,
    accum_green_bits: u8,
    accum_blue_bits: u8,
    accum_alpha_bits: u8,
    depth_bits: u8,
    stencil_bits: u8,
    aux_buffers: u8,
    layer_type: u8,
    reserved: u8,
    layer_mask: u32,
    visible_mask: u32,
    damage_mask: u32,
}

#[link(name = "user32")]
extern "system" {
    fn CreateWindowExW(
        ex_style: u32,
        class: *const u16,
        title: *const u16,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: Handle,
        menu: Handle,
        instance: Handle,
        param: Handle,
    ) -> Handle;
    fn GetDC(window: Handle) -> Handle;
    fn ReleaseDC(window: Handle, dc: Handle) -> i32;
    fn DestroyWindow(window: Handle) -> i32;
}
#[link(name = "gdi32")]
extern "system" {
    fn ChoosePixelFormat(dc: Handle, format: *const PixelFormat) -> i32;
    fn SetPixelFormat(dc: Handle, index: i32, format: *const PixelFormat) -> i32;
}
#[link(name = "opengl32")]
extern "system" {
    fn wglCreateContext(dc: Handle) -> Handle;
    fn wglDeleteContext(context: Handle) -> i32;
    fn wglMakeCurrent(dc: Handle, context: Handle) -> i32;
    fn wglGetProcAddress(name: *const c_char) -> *const c_void;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> Handle;
    fn GetProcAddress(module: Handle, name: *const c_char) -> *const c_void;
}

pub struct Context {
    window: Handle,
    dc: Handle,
    rendering: Handle,
}

impl Context {
    pub fn new() -> Result<Self, String> {
        let class: Vec<_> = "STATIC\0".encode_utf16().collect();
        let title: Vec<_> = "TerraWeave offline OpenGL\0".encode_utf16().collect();
        let library: Vec<_> = "opengl32.dll\0".encode_utf16().collect();
        unsafe {
            let window = CreateWindowExW(
                0,
                class.as_ptr(),
                title.as_ptr(),
                0x80000000,
                0,
                0,
                1,
                1,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
            );
            if window.is_null() {
                return Err("无法创建工作台离线 OpenGL 窗口".into());
            }
            let mut context = Self {
                window,
                dc: GetDC(window),
                rendering: null_mut(),
            };
            if context.dc.is_null() {
                return Err("无法取得工作台 OpenGL 设备".into());
            }
            let mut format: PixelFormat = std::mem::zeroed();
            format.size = std::mem::size_of::<PixelFormat>() as u16;
            format.version = 1;
            format.flags = 0x4 | 0x20; // PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL
            format.color_bits = 32;
            format.depth_bits = 24;
            let index = ChoosePixelFormat(context.dc, &format);
            if index == 0 || SetPixelFormat(context.dc, index, &format) == 0 {
                return Err("显卡无法创建 OpenGL 像素格式".into());
            }
            context.rendering = wglCreateContext(context.dc);
            if context.rendering.is_null() || wglMakeCurrent(context.dc, context.rendering) == 0 {
                return Err("显卡无法创建 OpenGL 兼容上下文".into());
            }
            let module = GetModuleHandleW(library.as_ptr());
            gl::load_with(|symbol| {
                let name = CString::new(symbol).expect("OpenGL symbol name");
                let address = wglGetProcAddress(name.as_ptr());
                let numeric = address as usize;
                if numeric <= 3 || numeric == usize::MAX {
                    GetProcAddress(module, name.as_ptr())
                } else {
                    address
                }
            });
            if !gl::CreateShader::is_loaded()
                || !gl::BindFramebuffer::is_loaded()
                || !gl::BlitFramebuffer::is_loaded()
                || !gl::BindSampler::is_loaded()
            {
                return Err("当前 OpenGL 驱动缺少光影所需能力".into());
            }
            Ok(context)
        }
    }
}

impl Drop for Context {
    fn drop(&mut self) {
        unsafe {
            if !self.rendering.is_null() {
                wglMakeCurrent(null_mut(), null_mut());
                wglDeleteContext(self.rendering);
            }
            if !self.dc.is_null() {
                ReleaseDC(self.window, self.dc);
            }
            DestroyWindow(self.window);
        }
    }
}
