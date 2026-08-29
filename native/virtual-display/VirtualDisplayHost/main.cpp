#include <windows.h>

#include <array>
#include <iostream>
#include <string>

int wmain(int argc, wchar_t* argv[])
{
    if (argc < 3)
    {
        std::wcerr
            << L"Usage: VirtualDisplayHost.exe "
            << L"<path-to-IddSampleApp.exe> "
            << L"<pipe-name>\n";

        return 1;
    }

    const std::wstring executablePath = argv[1];
    const std::wstring pipeName = argv[2];

    std::wcout
        << L"VirtualDisplayHost started\n"
        << L"Connecting to pipe: "
        << pipeName
        << L"\n";

    if (!WaitNamedPipeW(
            pipeName.c_str(),
            5000
        ))
    {
        std::wcerr
            << L"WaitNamedPipe failed: "
            << GetLastError()
            << L"\n";

        return 1;
    }

    HANDLE pipe = CreateFileW(
        pipeName.c_str(),
        GENERIC_READ | GENERIC_WRITE,
        0,
        nullptr,
        OPEN_EXISTING,
        0,
        nullptr
    );

    if (pipe == INVALID_HANDLE_VALUE)
    {
        std::wcerr
            << L"CreateFile for named pipe failed: "
            << GetLastError()
            << L"\n";

        return 1;
    }

    std::wcout
        << L"Connected to control pipe\n"
        << L"Starting IddSampleApp: "
        << executablePath
        << L"\n";

    HANDLE job = CreateJobObjectW(
        nullptr,
        nullptr
    );

    if (!job)
    {
        std::wcerr
            << L"CreateJobObject failed: "
            << GetLastError()
            << L"\n";

        CloseHandle(pipe);

        return 1;
    }

    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobInfo{};

    jobInfo.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

    if (!SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &jobInfo,
            sizeof(jobInfo)
        ))
    {
        std::wcerr
            << L"SetInformationJobObject failed: "
            << GetLastError()
            << L"\n";

        CloseHandle(job);
        CloseHandle(pipe);

        return 1;
    }

    STARTUPINFOW startupInfo{};
    startupInfo.cb = sizeof(startupInfo);

    PROCESS_INFORMATION processInfo{};

    std::wstring commandLine =
        L"\"" + executablePath + L"\"";

    if (!CreateProcessW(
            executablePath.c_str(),
            &commandLine[0],
            nullptr,
            nullptr,
            FALSE,
            CREATE_SUSPENDED,
            nullptr,
            nullptr,
            &startupInfo,
            &processInfo
        ))
    {
        std::wcerr
            << L"CreateProcess failed: "
            << GetLastError()
            << L"\n";

        CloseHandle(job);
        CloseHandle(pipe);

        return 1;
    }

    if (!AssignProcessToJobObject(
            job,
            processInfo.hProcess
        ))
    {
        std::wcerr
            << L"AssignProcessToJobObject failed: "
            << GetLastError()
            << L"\n";

        TerminateProcess(
            processInfo.hProcess,
            1
        );

        CloseHandle(
            processInfo.hThread
        );

        CloseHandle(
            processInfo.hProcess
        );

        CloseHandle(job);
        CloseHandle(pipe);

        return 1;
    }

    ResumeThread(
        processInfo.hThread
    );

    CloseHandle(
        processInfo.hThread
    );

    std::wcout
        << L"IddSampleApp started\n";

    std::string pendingCommand;

    while (true)
    {
        const DWORD processResult =
            WaitForSingleObject(
                processInfo.hProcess,
                100
            );

        if (processResult == WAIT_OBJECT_0)
        {
            std::wcout
                << L"IddSampleApp exited\n";

            break;
        }

        if (processResult == WAIT_FAILED)
        {
            std::wcerr
                << L"WaitForSingleObject failed: "
                << GetLastError()
                << L"\n";

            break;
        }

        DWORD availableBytes = 0;

        if (!PeekNamedPipe(
                pipe,
                nullptr,
                0,
                nullptr,
                &availableBytes,
                nullptr
            ))
        {
            std::wcout
                << L"Control pipe disconnected\n";

            break;
        }

        if (availableBytes == 0)
        {
            continue;
        }

        std::array<char, 64> buffer{};
        DWORD bytesRead = 0;

        if (!ReadFile(
                pipe,
                buffer.data(),
                static_cast<DWORD>(
                    buffer.size()
                ),
                &bytesRead,
                nullptr
            ))
        {
            std::wcout
                << L"Control pipe disconnected\n";

            break;
        }

        pendingCommand.append(
            buffer.data(),
            bytesRead
        );

        const std::size_t newline =
            pendingCommand.find('\n');

        if (newline == std::string::npos)
        {
            continue;
        }

        std::string command =
            pendingCommand.substr(
                0,
                newline
            );

        if (
            !command.empty() &&
            command.back() == '\r'
        )
        {
            command.pop_back();
        }

        if (command == "stop")
        {
            std::wcout
                << L"Stop command received\n";

            break;
        }

        pendingCommand.erase(
            0,
            newline + 1
        );
    }

    /*
     * Closing the Job Object would kill IddSampleApp
     * because of JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
     *
     * Explicitly terminating the job here makes normal
     * shutdown immediate instead of relying on cleanup
     * at process exit.
     */
    TerminateJobObject(
        job,
        0
    );

    WaitForSingleObject(
        processInfo.hProcess,
        2000
    );

    CloseHandle(
        processInfo.hProcess
    );

    CloseHandle(job);
    CloseHandle(pipe);

    std::wcout
        << L"VirtualDisplayHost stopped\n";

    return 0;
}