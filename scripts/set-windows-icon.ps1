param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$Icon
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

public static class WindowsIcon {
    private const int Icon = 3, IconGroup = 14;
    private delegate bool ResourceName(IntPtr module, IntPtr type, IntPtr name, IntPtr context);
    private delegate bool ResourceLanguage(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr context);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
    [DllImport("kernel32.dll")]
    private static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool EnumResourceNames(IntPtr module, IntPtr type, ResourceName callback, IntPtr context);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, ResourceLanguage callback, IntPtr context);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr BeginUpdateResource(string path, bool deleteExisting);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool EndUpdateResource(IntPtr update, bool discard);

    public static void Replace(string executable, string icon) {
        int groupId = 0;
        ushort language = 0;
        var module = LoadLibraryEx(executable, IntPtr.Zero, 2); // LOAD_LIBRARY_AS_DATAFILE
        if (module == IntPtr.Zero) throw new Win32Exception();
        try {
            int groups = 0, languages = 0;
            if (!EnumResourceNames(module, (IntPtr)IconGroup, (handle, type, name, context) => {
                groups++;
                if (name.ToInt64() > 0 && name.ToInt64() <= ushort.MaxValue) groupId = (int)name;
                return true;
            }, IntPtr.Zero)) throw new Win32Exception();
            if (groups != 1 || groupId == 0) throw new InvalidDataException("Expected one numeric Electron icon group.");
            if (!EnumResourceLanguages(module, (IntPtr)IconGroup, (IntPtr)groupId, (handle, type, name, id, context) => {
                languages++;
                language = id;
                return true;
            }, IntPtr.Zero)) throw new Win32Exception();
            if (languages != 1) throw new InvalidDataException("Expected one Electron icon language.");
        } finally {
            FreeLibrary(module);
        }

        using (var input = new BinaryReader(File.OpenRead(icon)))
        using (var group = new BinaryWriter(new MemoryStream())) {
            if (input.ReadUInt16() != 0 || input.ReadUInt16() != 1) throw new InvalidDataException("Invalid ICO header.");
            ushort count = input.ReadUInt16();
            if (count == 0) throw new InvalidDataException("The ICO has no images.");
            group.Write((ushort)0);
            group.Write((ushort)1);
            group.Write(count);

            var update = BeginUpdateResource(executable, false);
            if (update == IntPtr.Zero) throw new Win32Exception();
            bool commit = false;
            try {
                for (int index = 0; index < count; index++) {
                    // An ICO directory entry ends in an offset. A PE icon group uses a resource ID.
                    group.Write(input.ReadBytes(8));
                    int size = input.ReadInt32();
                    int offset = input.ReadInt32();
                    ushort id = checked((ushort)(1000 + index));
                    group.Write(size);
                    group.Write(id);
                    long nextEntry = input.BaseStream.Position;
                    if (size <= 0 || offset < 0 || (long)offset + size > input.BaseStream.Length)
                        throw new InvalidDataException("Invalid ICO image range.");
                    input.BaseStream.Position = offset;
                    Write(update, Icon, id, language, input.ReadBytes(size));
                    input.BaseStream.Position = nextEntry;
                }
                Write(update, IconGroup, groupId, language, ((MemoryStream)group.BaseStream).ToArray());
                commit = true;
            } finally {
                if (!EndUpdateResource(update, !commit) && commit) throw new Win32Exception();
            }
        }
    }

    private static void Write(IntPtr update, int type, int id, ushort language, byte[] data) {
        if (!UpdateResource(update, (IntPtr)type, (IntPtr)id, language, data, (uint)data.Length))
            throw new Win32Exception();
    }
}
'@

[WindowsIcon]::Replace($Executable, $Icon)
