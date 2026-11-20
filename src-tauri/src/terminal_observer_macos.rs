use super::Process;
use std::{mem::size_of_val, os::unix::fs::MetadataExt, ptr};

pub(super) fn read(terminals: &[String]) -> Option<Vec<Process>> {
    let mut rows = Vec::new();
    let mut arguments_buffer = Vec::new();
    for tty in terminals {
        let device = std::fs::metadata(format!("/dev/{tty}")).ok()?.rdev() as u32;
        for pid in pids(device)? {
            let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };
            let size = size_of_val(&info) as i32;
            let read = unsafe {
                libc::proc_pidinfo(
                    pid,
                    libc::PROC_PIDTBSDINFO,
                    0,
                    (&mut info as *mut libc::proc_bsdinfo).cast(),
                    size,
                )
            };
            if read != size {
                if vanished() {
                    continue;
                }
                return None;
            }
            if info.e_tdev != device || info.pbi_status == 5 {
                continue;
            }
            let mut path = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
            let read =
                unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
            if read <= 0 {
                if vanished() {
                    continue;
                }
                return None;
            }
            let end = path.iter().position(|byte| *byte == 0)?;
            let command = String::from_utf8_lossy(&path[..end]).into_owned();
            let mut row = Process {
                pid: info.pbi_pid,
                parent: info.pbi_ppid,
                group: info.pbi_pgid as i32,
                foreground: info.e_tpgid as i32,
                tty: tty.clone(),
                state: if info.pbi_status == 4 { "T" } else { "S" }.into(),
                command,
                args: String::new(),
            };
            if std::path::Path::new(&row.command)
                .file_name()
                .is_some_and(|name| name == "node" || name == "nodejs" || name == "bun")
            {
                if arguments_buffer.is_empty() {
                    let mut size: libc::c_int = 0;
                    let mut len = size_of_val(&size);
                    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
                    if unsafe {
                        libc::sysctl(
                            mib.as_mut_ptr(),
                            2,
                            (&mut size as *mut libc::c_int).cast(),
                            &mut len,
                            ptr::null_mut(),
                            0,
                        )
                    } != 0
                        || size <= 0
                        || size > 8 * 1024 * 1024
                    {
                        return None;
                    }
                    arguments_buffer.resize(size as usize, 0);
                }
                let mut len = arguments_buffer.len();
                let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
                if unsafe {
                    libc::sysctl(
                        mib.as_mut_ptr(),
                        3,
                        arguments_buffer.as_mut_ptr().cast(),
                        &mut len,
                        ptr::null_mut(),
                        0,
                    )
                } != 0
                {
                    if vanished() {
                        continue;
                    }
                    return None;
                }
                row.args = arguments(arguments_buffer.get(..len)?)?;
            }
            rows.push(row);
        }
    }
    Some(rows)
}

fn vanished() -> bool {
    matches!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH | libc::ENOENT)
    )
}

fn pids(device: u32) -> Option<Vec<i32>> {
    const PROC_TTY_ONLY: u32 = 3;
    let mut pids = vec![0i32; 32];
    loop {
        let size = size_of_val(pids.as_slice()) as i32;
        let read =
            unsafe { libc::proc_listpids(PROC_TTY_ONLY, device, pids.as_mut_ptr().cast(), size) };
        if read < 0 {
            return None;
        }
        if read < size {
            pids.truncate(read as usize / size_of_val(&0i32));
            pids.retain(|pid| *pid > 0);
            return Some(pids);
        }
        if pids.len() >= 1024 * 1024 {
            return None;
        }
        pids.resize(pids.len() * 2, 0);
    }
}

fn arguments(data: &[u8]) -> Option<String> {
    let count = i32::from_ne_bytes(data.get(..4)?.try_into().ok()?);
    if count <= 0 || count as usize > data.len() {
        return None;
    }
    let data = data.get(4..)?;
    let executable_end = data.iter().position(|byte| *byte == 0)?;
    let mut rest = data.get(executable_end..)?;
    let start = rest.iter().position(|byte| *byte != 0)?;
    rest = &rest[start..];
    let mut argv = Vec::new();
    for _ in 0..count {
        let end = rest.iter().position(|byte| *byte == 0)?;
        argv.push(String::from_utf8_lossy(&rest[..end]));
        rest = &rest[end + 1..];
    }
    Some(argv.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_skip_executable_padding_and_exclude_environment() {
        let mut bytes = 3i32.to_ne_bytes().to_vec();
        bytes.extend_from_slice(b"/usr/bin/node\0\0\0node\0/path/cli.js\0\0PRIVATE=value\0");
        assert_eq!(arguments(&bytes).unwrap(), "node /path/cli.js ");
        assert!(arguments(&bytes[..20]).is_none());
        assert!(arguments(&[255; 4]).is_none());
    }
}
