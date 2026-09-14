using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;

/// <summary>
/// Git launcher that drops Cursor Source Control's
/// GIT_CONFIG core.hooksPath=/dev/null override so pre-commit runs.
/// </summary>
internal static class Program
{
    private static int Main(string[] args)
    {
        StripNullDeviceOverrides();

        string git = FindGit();
        if (git == null)
        {
            Console.Error.WriteLine("git-with-hooks: git.exe not found");
            return 1;
        }

        var psi = new ProcessStartInfo();
        psi.FileName = git;
        psi.UseShellExecute = false;
        psi.Arguments = "";

        foreach (string arg in args)
        {
            psi.Arguments += Quote(arg) + " ";
        }

        using (Process child = Process.Start(psi))
        {
            if (child == null)
            {
                Console.Error.WriteLine("git-with-hooks: failed to start git");
                return 1;
            }

            child.WaitForExit();
            return child.ExitCode;
        }
    }

    private static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0)
        {
            return arg;
        }

        return "\"" + arg.Replace("\"", "\\\"") + "\"";
    }

    private static void StripNullDeviceOverrides()
    {
        string countStr = Environment.GetEnvironmentVariable("GIT_CONFIG_COUNT");
        int count;
        if (string.IsNullOrEmpty(countStr) || !int.TryParse(countStr, out count) || count <= 0)
        {
            return;
        }

        var kept = new List<KeyValuePair<string, string>>();

        for (int i = 0; i < count; i++)
        {
            string key = Environment.GetEnvironmentVariable("GIT_CONFIG_KEY_" + i);
            string val = Environment.GetEnvironmentVariable("GIT_CONFIG_VALUE_" + i);

            if (IsNullDeviceOverride(key, val))
            {
                continue;
            }

            kept.Add(new KeyValuePair<string, string>(key, val));
        }

        for (int i = 0; i < count; i++)
        {
            Environment.SetEnvironmentVariable("GIT_CONFIG_KEY_" + i, null);
            Environment.SetEnvironmentVariable("GIT_CONFIG_VALUE_" + i, null);
        }

        Environment.SetEnvironmentVariable("GIT_CONFIG_COUNT", kept.Count.ToString());

        for (int i = 0; i < kept.Count; i++)
        {
            Environment.SetEnvironmentVariable("GIT_CONFIG_KEY_" + i, kept[i].Key);
            Environment.SetEnvironmentVariable("GIT_CONFIG_VALUE_" + i, kept[i].Value);
        }
    }

    private static bool IsNullDeviceOverride(string key, string val)
    {
        if (string.IsNullOrEmpty(key) || string.IsNullOrEmpty(val))
        {
            return false;
        }

        bool interesting =
            key.Equals("core.hooksPath", StringComparison.OrdinalIgnoreCase)
            || key.Equals("core.attributesFile", StringComparison.OrdinalIgnoreCase);

        if (!interesting)
        {
            return false;
        }

        string n = val.Trim();

        return n.Equals("/dev/null", StringComparison.OrdinalIgnoreCase)
            || n.Equals("nul", StringComparison.OrdinalIgnoreCase)
            || n.Equals("\\\\.\\nul", StringComparison.OrdinalIgnoreCase)
            || n.Equals("\\Device\\Null", StringComparison.OrdinalIgnoreCase);
    }

    private static string FindGit()
    {
        string fromEnv = Environment.GetEnvironmentVariable("PIPELINE_REAL_GIT");

        if (!string.IsNullOrEmpty(fromEnv) && File.Exists(fromEnv))
        {
            return fromEnv;
        }

        string[] wellKnown = new[]
        {
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                "Git",
                "cmd",
                "git.exe"),
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                "Git",
                "cmd",
                "git.exe"),
        };

        foreach (string candidate in wellKnown)
        {
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";

        foreach (string dir in pathEnv.Split(Path.PathSeparator))
        {
            if (string.IsNullOrEmpty(dir))
            {
                continue;
            }

            string candidate = Path.Combine(dir, "git.exe");

            if (!File.Exists(candidate))
            {
                continue;
            }

            if (candidate.IndexOf("git-with-hooks", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                continue;
            }

            return candidate;
        }

        return null;
    }
}
