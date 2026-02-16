#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <string.h>
#include <errno.h>

#define SEV_GUEST_DEVICE "/dev/sev-guest"

// Structures defined as per Linux kernel sev-guest.h
struct snp_report_req {
    uint8_t user_data[64];
    uint32_t vmpl;
    uint8_t rsvd[28];
};

struct snp_report_resp {
    uint8_t data[4000];
};

struct snp_guest_request_ioctl {
    uint8_t msg_version;
    uint64_t req_data;
    uint64_t resp_data;
    uint64_t exitinfo2;
};

#define SNP_GET_REPORT _IOWR('S', 0x0, struct snp_guest_request_ioctl)

void hex_to_bytes(const char *hex, uint8_t *bytes, size_t len) {
    for (size_t i = 0; i < len; i++) {
        sscanf(&hex[i * 2], "%2hhx", &bytes[i]);
    }
}

int main(int argc, char *argv[]) {
    if (argc != 2) {
        fprintf(stderr, "Usage: %s <64-byte-hex-report-data>\n", argv[0]);
        return 1;
    }

    const char *hex_data = argv[1];
    if (strlen(hex_data) != 128) { // 64 bytes * 2 chars
        fprintf(stderr, "Error: Report data must be 64 bytes (128 hex characters). Got %lu\n", strlen(hex_data));
        return 1;
    }

    int fd = open(SEV_GUEST_DEVICE, O_RDWR);
    if (fd < 0) {
        perror("Failed to open /dev/sev-guest");
        return 1;
    }

    struct snp_report_req req;
    memset(&req, 0, sizeof(req));
    hex_to_bytes(hex_data, req.user_data, 64);
    req.vmpl = 0; // Request report for VMPL 0

    struct snp_report_resp resp;
    memset(&resp, 0, sizeof(resp));

    struct snp_guest_request_ioctl ioctl_data;
    memset(&ioctl_data, 0, sizeof(ioctl_data));
    ioctl_data.msg_version = 1;
    ioctl_data.req_data = (uint64_t)&req;
    ioctl_data.resp_data = (uint64_t)&resp;

    if (ioctl(fd, SNP_GET_REPORT, &ioctl_data) < 0) {
        perror("Ioctl SNP_GET_REPORT failed");
        close(fd);
        return 1;
    }

    // Write the raw report to stdout
    // The report size is typically 1184 bytes, but the response buffer is 4000.
    // We should write the actual report structure size, which is fixed for SNP.
    // However, for simplicity and since we control the reader, we can write the first 1344 bytes 
    // (standard report size + signature) or just what's returned.
    // The Standard Attestation Report is 1184 bytes.
    // Let's write the first 1184 bytes as that covers the report. 
    // Note: The response data contains the attestation report.
    // According to specs, the format is:
    // 0x0: Attestation Report (1184 bytes)
    // The buffer is larger for future expansion.
    
    if (write(STDOUT_FILENO, resp.data, 1184) != 1184) {
        perror("Failed to write output");
        close(fd);
        return 1;
    }

    close(fd);
    return 0;
}
